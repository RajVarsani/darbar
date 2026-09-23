// DAR-266. The Linear GraphQL client, behind an interface so the sync (linear-sync.ts) is built and
// tested against a stub. This file is the only place that knows Linear's wire format.
//
// Personal API keys go in the Authorization header as-is (no Bearer prefix). The key is never put in
// an error message: a failed call is recorded on a board row, and the board is shareable.

export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate' | (string & {});
export type LinearState = { id: string; name: string; type: LinearStateType; position: number };

export type LinearIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  stateId: string;
  stateType: LinearStateType;
  updatedAt: string; // ISO; the echo and conflict checks compare it verbatim
  labelIds: string[];
};

export type IssueCreateInput = {
  id: string; // client-generated uuid: a retry reuses it, so one row can never become two issues
  teamId: string;
  projectId?: string | null;
  title: string;
  description: string;
  stateId?: string | null;
  labelIds: string[];
};
export type IssueUpdateInput = { title?: string; description?: string; stateId?: string };

export type IssuePage = { issues: LinearIssue[]; endCursor: string | null; hasNextPage: boolean };

export interface LinearClient {
  teamByKey(key: string): Promise<{ id: string; key: string } | null>;
  projectBySlugId(slugId: string): Promise<{ id: string; teamIds: string[] } | null>;
  workflowStates(teamId: string): Promise<LinearState[]>;
  /** the label group's own team, null when it is a workspace label (children must match it) */
  labelTeam(labelId: string): Promise<string | null>;
  findChildLabel(parentId: string, name: string): Promise<{ id: string } | null>;
  /** a label by exact name anywhere in the workspace (the older flat "darbar/<PREFIX>" labels) */
  findLabelByName(name: string): Promise<{ id: string } | null>;
  createChildLabel(input: { parentId: string; name: string; teamId?: string | null }): Promise<{ id: string }>;
  /** null when the issue does not exist (never created, deleted, or not visible to the key) */
  getIssue(id: string): Promise<LinearIssue | null>;
  createIssue(input: IssueCreateInput): Promise<LinearIssue>;
  updateIssue(id: string, input: IssueUpdateInput): Promise<LinearIssue>;
  commentExists(id: string): Promise<boolean>;
  /** returns the issue's updatedAt after the comment, so the poll can recognise its own echo */
  createComment(input: { id: string; issueId: string; body: string }): Promise<{ issueUpdatedAt: string | null }>;
  listLabelledIssues(labelId: string, updatedSince: string | null, after: string | null): Promise<IssuePage>;
}

const ISSUE_FIELDS = 'id identifier url title description updatedAt labelIds state { id type }';
type RawIssue = {
  id: string; identifier: string; url: string; title: string; description: string | null;
  updatedAt: string; labelIds: string[]; state: { id: string; type: string };
};
const toIssue = (r: RawIssue): LinearIssue => ({
  id: r.id, identifier: r.identifier, url: r.url, title: r.title, description: r.description,
  stateId: r.state.id, stateType: r.state.type, updatedAt: r.updatedAt, labelIds: r.labelIds ?? [],
});

const TIMEOUT_MS = 15_000;

export function graphqlLinearClient(
  apiKey: string,
  opts: { url?: string; fetch?: typeof fetch } = {},
): LinearClient {
  const url = opts.url ?? 'https://api.linear.app/graphql';
  const f = opts.fetch ?? fetch;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
    if (!r.ok || !j || j.errors?.length || !j.data) {
      const msg = j?.errors?.map((e) => e.message).join('; ') || `http ${r.status}`;
      throw new Error(`linear: ${msg}`);
    }
    return j.data;
  }

  return {
    async teamByKey(key) {
      const d = await gql<{ teams: { nodes: { id: string; key: string }[] } }>(
        'query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes{ id key } } }', { k: key });
      return d.teams.nodes[0] ?? null;
    },
    async projectBySlugId(slugId) {
      const d = await gql<{ projects: { nodes: { id: string; teams: { nodes: { id: string }[] } }[] } }>(
        'query($s:String!){ projects(filter:{slugId:{eq:$s}}){ nodes{ id teams{ nodes{ id } } } } }', { s: slugId });
      const p = d.projects.nodes[0];
      return p ? { id: p.id, teamIds: p.teams.nodes.map((t) => t.id) } : null;
    },
    async workflowStates(teamId) {
      const d = await gql<{ workflowStates: { nodes: LinearState[] } }>(
        'query($t:ID!){ workflowStates(filter:{team:{id:{eq:$t}}}){ nodes{ id name type position } } }', { t: teamId });
      return d.workflowStates.nodes;
    },
    async labelTeam(labelId) {
      const d = await gql<{ issueLabel: { team: { id: string } | null } }>(
        'query($id:String!){ issueLabel(id:$id){ team{ id } } }', { id: labelId });
      return d.issueLabel.team?.id ?? null;
    },
    async findChildLabel(parentId, name) {
      const d = await gql<{ issueLabels: { nodes: { id: string }[] } }>(
        'query($p:ID!,$n:String!){ issueLabels(filter:{parent:{id:{eq:$p}}, name:{eqIgnoreCase:$n}}){ nodes{ id } } }',
        { p: parentId, n: name });
      return d.issueLabels.nodes[0] ?? null;
    },
    async findLabelByName(name) {
      const d = await gql<{ issueLabels: { nodes: { id: string }[] } }>(
        'query($n:String!){ issueLabels(filter:{name:{eq:$n}}){ nodes{ id } } }', { n: name });
      return d.issueLabels.nodes[0] ?? null;
    },
    async createChildLabel({ parentId, name, teamId }) {
      const d = await gql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } } }>(
        'mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ success issueLabel{ id } } }',
        { i: { parentId, name, ...(teamId ? { teamId } : {}) } });
      return d.issueLabelCreate.issueLabel;
    },
    async getIssue(id) {
      // a filter rather than issue(id:), which answers a missing id with an error we would have to
      // string-match; an empty page is unambiguous
      const d = await gql<{ issues: { nodes: RawIssue[] } }>(
        `query($id:ID!){ issues(filter:{id:{eq:$id}}){ nodes{ ${ISSUE_FIELDS} } } }`, { id });
      const n = d.issues.nodes[0];
      return n ? toIssue(n) : null;
    },
    async createIssue(input) {
      const i: Record<string, unknown> = {
        id: input.id, teamId: input.teamId, title: input.title, description: input.description, labelIds: input.labelIds,
      };
      if (input.projectId) i.projectId = input.projectId;
      if (input.stateId) i.stateId = input.stateId;
      const d = await gql<{ issueCreate: { issue: RawIssue } }>(
        `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ ${ISSUE_FIELDS} } } }`, { i });
      return toIssue(d.issueCreate.issue);
    },
    async updateIssue(id, input) {
      const d = await gql<{ issueUpdate: { issue: RawIssue } }>(
        `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id, input:$i){ success issue{ ${ISSUE_FIELDS} } } }`,
        { id, i: input });
      return toIssue(d.issueUpdate.issue);
    },
    async commentExists(id) {
      const d = await gql<{ comments: { nodes: { id: string }[] } }>(
        'query($id:ID!){ comments(filter:{id:{eq:$id}}){ nodes{ id } } }', { id });
      return d.comments.nodes.length > 0;
    },
    async createComment({ id, issueId, body }) {
      const d = await gql<{ commentCreate: { comment: { issue: { updatedAt: string } | null } } }>(
        'mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment{ issue{ updatedAt } } } }',
        { i: { id, issueId, body } });
      return { issueUpdatedAt: d.commentCreate.comment.issue?.updatedAt ?? null };
    },
    async listLabelledIssues(labelId, updatedSince, after) {
      const filter: Record<string, unknown> = { labels: { id: { eq: labelId } } };
      if (updatedSince) filter.updatedAt = { gte: updatedSince };
      const d = await gql<{ issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        `query($f:IssueFilter,$a:String){ issues(filter:$f, first:50, after:$a, orderBy:updatedAt){ nodes{ ${ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`,
        { f: filter, a: after });
      return { issues: d.issues.nodes.map(toIssue), endCursor: d.issues.pageInfo.endCursor, hasNextPage: d.issues.pageInfo.hasNextPage };
    },
  };
}
