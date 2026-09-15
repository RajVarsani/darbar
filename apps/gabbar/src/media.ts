// Making attachments legible to the model.
//
// Before this, an attachment reached the model as a URL in the system prompt and nothing
// else. That is fine for the feedback row (a human clicks it) and useless for comprehension:
// the model has no fetch tool, so a screenshot contributed no pixels and a .mov contributed
// less than nothing, since the filed body sounded grounded while resting on the filename.
// a teammate's calendar recording is the case in point — Raj ended up typing out the cause the
// video already showed.
//
// ---------- one pass, so the prompt cannot lie ----------
// The first version derived the prompt inventory and the image blocks separately, and they
// disagreed: a zero-byte image was announced as "shown to you below, describe what you can
// see" while no block was emitted, and a recording whose frames mostly failed to extract was
// still introduced as frames "at its moments of change, in time order". Both told the model it
// could see something it could not, which is the exact failure the ffmpeg check exists to
// avoid. So readability is now decided by ENCODING THE BYTES, and the description is generated
// from the encodings that succeeded, in the same pass, by prepareAttachments. There is no
// second derivation left to diverge, and every claim in the inventory is a fact about a block
// that exists.
//
// ---------- frame sampling ----------
// These are short UI screen captures where the interesting moment is a transition, so the
// sampling is transition-seeking rather than evenly spaced:
//
//   1. one cheap scan pass computes a per-frame scene score, on a stream decimated to 8fps
//      and scaled to 426px wide
//   2. candidates are RANKED by that score, not thresholded, then accepted greedily with a
//      0.6s minimum spacing so one animation cannot eat the whole budget
//   3. the first and last frame are always included, for the baseline and the end state
//
// Ranking instead of thresholding is the load-bearing choice, and it came from measuring the
// real recording: its scene scores top out at 0.0065, two orders of magnitude under the
// conventional 0.3 cut, because the thing that moves is a popover inside a 3024x1964 screen.
// Any fixed threshold tuned for cuts in video finds nothing at all in a UI capture. Ranking
// finds the moments regardless of how small a slice of the screen changed.
//
// Decimating to 8fps before scoring cut the scan on that clip from 6.3s to 1.2s, and it also
// detects BETTER: comparing frames 125ms apart makes a layout flip a large delta, where
// comparing adjacent 16ms frames spreads it thinly across an animation.
//
// The sampled timestamps are a REQUEST, not a result. A truncated file answers ffprobe with
// its full duration and then refuses to seek, so what actually came back is measured against
// what was asked for, and the inventory reports the span the frames really cover.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG = Bun.which('ffmpeg');
const FFPROBE = Bun.which('ffprobe');
export const hasFfmpeg = Boolean(FFMPEG && FFPROBE);

// budgets. 1280px wide is ~1.4k input tokens a frame and keeps UI labels readable (checked
// against a 3024px retina capture); 8 frames of that is a bounded ~11k tokens.
const FRAME_WIDTH = 1280;
const MAX_FRAMES_PER_VIDEO = 8;
const MAX_FRAMES_TOTAL = 12;
const MAX_IMAGES = 8;
const MIN_FRAME_GAP_S = 0.6;
const SCAN_FPS = 8;
// past this length the scan pass is not worth its wall time; fall back to even spacing
const SCAN_MAX_DURATION_S = 180;
// anthropic rejects images past ~5MB; shrink or decline before we get there
const MAX_IMAGE_BYTES = 4_500_000;
// a slack filename is fully untrusted text that lands in the highest-trust part of the prompt
const NAME_MAX = 80;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const IMAGE_EXTS: Record<string, ImageType> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const IMAGE_MIMES: ImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const VIDEO_EXTS = new Set(['mov', 'mp4', 'm4v', 'webm', 'avi', 'mkv', 'mpeg', 'mpg', 'ogv', 'qt']);

export type Frame = { url: string; path: string; at: number };

export type MediaItem = {
  /** darbar /files/ url of the original upload — this is what the feedback row links to */
  url: string;
  path: string;
  name: string;
  kind: 'image' | 'video' | 'other';
  /** frames whose bytes were successfully encoded, i.e. exactly the ones the model was shown */
  frames: Frame[];
  /** true only if at least one image block was built from this upload */
  readable: boolean;
  /** honest caveat: why nothing was read, or what is missing from what was read */
  note: string | null;
};

export type VisionBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageType; data: string } };

export type Attachments = {
  items: MediaItem[];
  /** exactly what is sent to the model, already encoded */
  blocks: VisionBlock[];
  /** the prompt inventory, generated FROM the blocks above */
  inventory: string;
};

export const NO_ATTACHMENTS: Attachments = { items: [], blocks: [], inventory: 'none' };

async function run(cmd: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(9); } catch {} }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0 && !timedOut, stdout, stderr: timedOut ? `timed out after ${timeoutMs}ms` : stderr };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e) };
  }
}

/** newlines and length are clamped: this string lands inside the authoritative prompt block */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned.length > NAME_MAX ? `${cleaned.slice(0, NAME_MAX)}…` : cleaned) || 'file';
}

/**
 * A real extension beats a mimetype, because slack supplies the mimetype and it can be wrong.
 * Getting this order backwards sent video bytes labelled image/png, which is a hard API error
 * for the whole turn instead of a caveat on one file.
 */
export function classify(name: string, mimetype?: string): MediaItem['kind'] {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const mt = (mimetype ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS[ext]) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (IMAGE_MIMES.includes(mt as ImageType)) return 'image';
  return 'other';
}

/** the declared type is a claim; the magic bytes are the fact */
function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** the single decision point for "can the model see this": it either encodes, or it does not */
async function encodeImage(file: string): Promise<{ block: VisionBlock } | { error: string }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  } catch (e) {
    return { error: `the file could not be read (${String(e).slice(0, 60)})` };
  }
  if (bytes.byteLength === 0) return { error: 'the file is empty' };
  const mediaType = sniffImage(bytes);
  if (!mediaType) return { error: 'the bytes are not a png, jpeg, gif or webp image' };
  try {
    return { block: { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(bytes).toString('base64') } } };
  } catch (e) {
    return { error: `the image could not be encoded (${String(e).slice(0, 60)})` };
  }
}

async function duration(file: string): Promise<number | null> {
  if (!FFPROBE) return null;
  const r = await run([FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 10_000);
  const d = Number(r.stdout.trim());
  return r.ok && Number.isFinite(d) && d > 0 ? d : null;
}

/** one scan pass: every sampled frame's timestamp and how much it changed from the previous one */
async function sceneScores(file: string): Promise<Array<{ at: number; score: number }>> {
  if (!FFMPEG) return [];
  const r = await run([
    FFMPEG, '-nostdin', '-v', 'error', '-i', file, '-an', '-sn',
    '-vf', `fps=${SCAN_FPS},scale=426:-2:flags=fast_bilinear,select='gt(scene,0)',metadata=print:file=-`,
    '-f', 'null', '/dev/null',
  ], 60_000);
  if (!r.ok) return [];
  const out: Array<{ at: number; score: number }> = [];
  let at: number | null = null;
  for (const line of r.stdout.split('\n')) {
    const t = /pts_time:([0-9.]+)/.exec(line);
    if (t?.[1] !== undefined) { at = Number(t[1]); continue; }
    const s = /scene_score=([0-9.]+)/.exec(line);
    if (s?.[1] !== undefined && at !== null) { out.push({ at, score: Number(s[1]) }); at = null; }
  }
  return out;
}

/** rank by change, spread in time, always keep the baseline and the end state */
function pickTimestamps(scores: Array<{ at: number; score: number }>, dur: number, budget: number): number[] {
  const last = Math.max(0, dur - 0.15);
  const picked: number[] = [0];
  if (last > MIN_FRAME_GAP_S) picked.push(last);
  const spaced = (t: number) => picked.every((p) => Math.abs(p - t) >= MIN_FRAME_GAP_S);
  for (const c of [...scores].sort((a, b) => b.score - a.score)) {
    if (picked.length >= budget) break;
    if (c.at > 0 && c.at < last && spaced(c.at)) picked.push(c.at);
  }
  // a capture with almost no measurable change still deserves a timeline, not two frames
  if (picked.length < Math.min(4, budget)) {
    const want = Math.min(budget, 4);
    for (let i = 1; i < want && picked.length < budget; i++) {
      const t = (dur * i) / want;
      if (spaced(t)) picked.push(t);
    }
  }
  return picked.sort((a, b) => a - b).slice(0, budget);
}

function frameName(uniqueBase: string, i: number, at: number): string {
  const base = uniqueBase.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  return `${base}-frame${String(i + 1).padStart(2, '0')}-t${at.toFixed(2)}s.jpg`;
}

type VideoRead = { frames: Frame[]; blocks: VisionBlock[]; note: string | null; duration: number | null; requested: number };

async function readVideo(
  f: { path: string; name: string; storedName: string },
  outDir: string,
  baseUrl: string,
  budget: number,
): Promise<VideoRead> {
  const none = (note: string): VideoRead => ({ frames: [], blocks: [], note, duration: null, requested: 0 });
  if (!hasFfmpeg) return none('ffmpeg is not installed on this host, so the recording could not be read at all');
  const dur = await duration(f.path);
  if (dur === null) return none('the recording could not be opened, so nothing in it was read');

  let coarse = false;
  let times: number[];
  if (dur > SCAN_MAX_DURATION_S) {
    coarse = true;
    times = Array.from({ length: budget }, (_, i) => (dur * (i + 0.5)) / budget);
  } else {
    const scores = await sceneScores(f.path);
    times = pickTimestamps(scores, dur, budget);
    if (scores.length === 0) coarse = true;
  }

  // extract, then ENCODE. A frame that will not encode was never seen, so it is not a frame.
  const frames: Frame[] = [];
  const frameBlocks: VisionBlock[] = [];
  for (const [i, at] of times.entries()) {
    const name = frameName(f.storedName, i, at);
    const out = path.join(outDir, name);
    const r = await run([
      FFMPEG!, '-nostdin', '-v', 'error', '-ss', at.toFixed(3), '-i', f.path,
      '-frames:v', '1', '-vf', `scale='min(${FRAME_WIDTH},iw)':-2:flags=lanczos`, '-q:v', '4', '-y', out,
    ], 20_000);
    if (!r.ok) continue;
    const enc = await encodeImage(out);
    if ('error' in enc) continue;
    frames.push({ url: `${baseUrl}/files/${name}`, path: out, at });
    frameBlocks.push({ type: 'text', text: `frame at ${at.toFixed(2)}s:` }, enc.block);
  }

  if (frames.length === 0) {
    return { ...none('no frames could be extracted from the recording, so nothing in it was read'), duration: dur, requested: times.length };
  }

  // what came back, measured against what was asked for. A truncated file reports its full
  // duration and then refuses to seek, so this is the only place the shortfall shows up.
  const notes: string[] = [];
  const lastAt = frames[frames.length - 1]!.at;
  const missing = times.length - frames.length;
  const tailGap = dur - lastAt;
  if (missing > 0) notes.push(`${missing} of the ${times.length} sampled frames could not be extracted`);
  if (tailGap > Math.max(1, dur * 0.05)) {
    notes.push(`the frames stop at ${lastAt.toFixed(2)}s of a ${dur.toFixed(2)}s recording, so the END of it was NOT read: you have not seen how it finished and must not describe the end state`);
  }
  if (coarse) notes.push('frames are evenly spaced rather than picked at the moments of change, so a brief transition may be missing');
  if (dur > SCAN_MAX_DURATION_S) notes.push(`the recording is ${Math.round(dur)}s long and only ${frames.length} frames were sampled from it`);

  return { frames, blocks: frameBlocks, note: notes.length ? notes.join('; ') : null, duration: dur, requested: times.length };
}

/** oversized images are shrunk before encoding; failure here is a caveat, never a silent pass */
async function fitImage(f: { path: string; storedName: string }, outDir: string): Promise<{ path: string } | { error: string }> {
  let size = 0;
  try {
    size = Bun.file(f.path).size;
  } catch (e) {
    return { error: `the file could not be read (${String(e).slice(0, 60)})` };
  }
  if (size <= MAX_IMAGE_BYTES) return { path: f.path };
  if (!FFMPEG) {
    return { error: `the image is ${Math.round(size / 1e6)}MB, too large to read, and ffmpeg is not installed here to shrink it` };
  }
  const out = path.join(outDir, `${f.storedName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}-fit.jpg`);
  const r = await run([
    FFMPEG, '-nostdin', '-v', 'error', '-i', f.path,
    '-vf', `scale='min(${FRAME_WIDTH},iw)':-2:flags=lanczos`, '-frames:v', '1', '-q:v', '4', '-y', out,
  ], 20_000);
  return r.ok ? { path: out } : { error: 'the image could not be resized down to a readable size, so it was not read' };
}

export type Upload = {
  url: string;
  /** local path of the downloaded original */
  path: string;
  /** the sender's filename, untrusted */
  name: string;
  /** the collision-free name it was stored under; frame filenames derive from this */
  storedName: string;
  mimetype?: string;
};

/**
 * Turn downloaded uploads into what the model is shown plus a description OF THAT. Never
 * throws: anything that cannot be read comes back as NOT READABLE in the inventory, with the
 * reason, and contributes no blocks.
 */
export async function prepareAttachments(uploads: Upload[], outDir: string, baseUrl: string): Promise<Attachments> {
  if (!uploads.length) return NO_ATTACHMENTS;
  try {
    fs.mkdirSync(outDir, { recursive: true }); // else every frame write fails and reads as unreadable
  } catch { /* the per-file failure paths below report it honestly */ }
  const kinds = uploads.map((u) => classify(u.name, u.mimetype));
  const videos = kinds.filter((k) => k === 'video').length;
  // MAX_FRAMES_TOTAL has to be a real cap, so it is spent from a running balance rather than
  // guessed per video. The old max(3, ...) floor defeated it: five recordings in one message
  // bought 15 frames and ten bought 30. Anything the balance cannot pay for is reported as
  // unread rather than quietly skipped.
  const perVideo = videos ? Math.min(MAX_FRAMES_PER_VIDEO, Math.max(1, Math.floor(MAX_FRAMES_TOTAL / videos))) : 0;
  let framesLeft = MAX_FRAMES_TOTAL;
  let imagesLeft = MAX_IMAGES;

  const items: MediaItem[] = [];
  const blocks: VisionBlock[] = [];
  const lines: string[] = [];

  for (const [i, u] of uploads.entries()) {
    const kind = kinds[i]!;
    const shown = safeName(u.name);
    const base = { url: u.url, path: u.path, name: u.name, kind };

    if (kind === 'image') {
      if (imagesLeft <= 0) {
        const why = `more than ${MAX_IMAGES} images were attached, and this one was not read`;
        items.push({ ...base, frames: [], readable: false, note: why });
        lines.push(`image "${shown}" (${u.url}) — NOT READABLE: ${why}`);
        continue;
      }
      const fitted = await fitImage(u, outDir);
      const enc = 'error' in fitted ? { error: fitted.error } : await encodeImage(fitted.path);
      if ('error' in enc) {
        // the slot is spent on what the model can SEE: an unreadable image must not cost a
        // readable one its place
        items.push({ ...base, frames: [], readable: false, note: enc.error });
        lines.push(`image "${shown}" (${u.url}) — NOT READABLE: ${enc.error}`);
        continue;
      }
      imagesLeft -= 1;
      items.push({ ...base, frames: [], readable: true, note: null });
      blocks.push({ type: 'text', text: `attached image "${shown}" (${u.url}):` }, enc.block);
      lines.push(`image "${shown}" (${u.url}) — shown to you below, describe what you can see`);
      continue;
    }

    if (kind === 'video') {
      const allowance = Math.min(perVideo, framesLeft);
      if (allowance <= 0) {
        const why = `too many recordings were attached to read them all, and this one was not read`;
        items.push({ ...base, frames: [], readable: false, note: why });
        lines.push(`screen recording "${shown}" (${u.url}) — NOT READABLE: ${why}`);
        continue;
      }
      const read = await readVideo({ ...u, storedName: u.storedName }, outDir, baseUrl, allowance);
      framesLeft -= read.frames.length;
      if (read.frames.length === 0) {
        const why = read.note ?? 'no frames could be extracted';
        items.push({ ...base, frames: [], readable: false, note: why });
        lines.push(`screen recording "${shown}" (${u.url}) — NOT READABLE: ${why}`);
        continue;
      }
      // every claim below is a fact about the blocks that exist, not about what was requested
      const first = read.frames[0]!.at;
      const last = read.frames[read.frames.length - 1]!.at;
      const n = read.frames.length;
      const count = `${n} frame${n === 1 ? '' : 's'}`;
      const span = `${first.toFixed(2)}s to ${last.toFixed(2)}s${read.duration ? ` of a ${read.duration.toFixed(2)}s recording` : ''}`;
      items.push({ ...base, frames: read.frames, readable: true, note: read.note });
      blocks.push({
        type: 'text',
        text: `attached screen recording "${shown}" (${u.url}), read as ${count} covering ${span}, in time order. compare them to work out what changed and when. you have seen these frames and nothing else of this recording.`,
      });
      blocks.push(...read.blocks);
      if (read.note) blocks.push({ type: 'text', text: `CAVEAT on "${shown}": ${read.note}` });
      lines.push(`screen recording "${shown}" (${u.url}) — ${count} covering ${span} shown to you below${read.note ? `. CAVEAT: ${read.note}` : ''}`);
      continue;
    }

    const why = 'this file type cannot be read, only linked';
    items.push({ ...base, frames: [], readable: false, note: why });
    lines.push(`file "${shown}" (${u.url}) — NOT READABLE: ${why}`);
  }

  return { items, blocks, inventory: lines.join('\n  ') };
}

/** the condensed inventory for the parked-report record */
export function mediaNotes(items: MediaItem[]): string[] {
  return items.map((m) => {
    const frames = m.frames.length ? ` frames: ${m.frames.map((f) => f.url).join(' ')}` : '';
    return `${m.kind} ${safeName(m.name)} -> ${m.url}${frames}${m.note ? ` (${m.note})` : ''}`;
  });
}
