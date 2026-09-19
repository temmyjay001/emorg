export interface JiraIssue {
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  labels: string[];
  assigneeAccountId: string | null;
  status: string;
}

export interface JiraTransition {
  id: string;
  toStatus: string;
}

export interface JiraClientOptions {
  site: string;
  email: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`Jira API ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

function issueFromPayload(raw: Record<string, unknown>): JiraIssue {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  const project = (fields.project ?? {}) as Record<string, unknown>;
  const assignee = fields.assignee as Record<string, unknown> | null | undefined;
  const status = (fields.status ?? {}) as Record<string, unknown>;
  return {
    key: String(raw.key ?? ''),
    projectKey: String(project.key ?? String(raw.key ?? '').split('-')[0] ?? ''),
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    description: typeof fields.description === 'string' ? fields.description : '',
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    assigneeAccountId: assignee && typeof assignee.accountId === 'string' ? assignee.accountId : null,
    status: typeof status.name === 'string' ? status.name : '',
  };
}

export class JiraClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JiraClientOptions) {
    this.base = opts.site.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new JiraApiError(res.status, path, text);
    return text ? JSON.parse(text) : null;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const raw = (await this.request(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,labels,assignee,status,project`,
    )) as Record<string, unknown>;
    return issueFromPayload(raw);
  }

  async addComment(key: string, text: string): Promise<void> {
    await this.request('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: text });
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const raw = (await this.request('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`)) as {
      transitions?: Array<{ id: string; to?: { name?: string } }>;
    };
    return (raw.transitions ?? []).map((t) => ({ id: String(t.id), toStatus: String(t.to?.name ?? '') }));
  }

  async transitionTo(key: string, statusName: string): Promise<boolean> {
    const transitions = await this.getTransitions(key);
    const match = transitions.find((t) => t.toStatus.toLowerCase() === statusName.toLowerCase());
    if (!match) return false;
    await this.request('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: match.id },
    });
    return true;
  }
}
