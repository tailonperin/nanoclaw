/**
 * GitLab MCP Server for NanoClaw
 * Exposes controlled GitLab operations to the agent.
 *
 * Protection layers (enforced in code, not instructions):
 *   - Commits and branch creation are hard-blocked for main/master
 *   - Token never exposed to the agent's bash environment
 *
 * Config via environment variables (injected by OneCLI):
 *   GITLAB_URL   - GitLab base URL (default: https://gitlab.com)
 *   GITLAB_TOKEN - Personal access token with read_api + write_repository
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const GITLAB_URL = (process.env.GITLAB_URL || 'https://gitlab.com').replace(/\/$/, '');
const PROJECTS_DIR = '/workspace/project/projects';

function getToken(): string {
  const token = process.env.GITLAB_TOKEN;
  if (!token) throw new Error('GITLAB_TOKEN env var is not set');
  return token;
}

// Protected branches — hard block, not configurable by the agent
const PROTECTED_BRANCH_NAMES = new Set(['main', 'master']);

function assertNotProtectedBranch(branch: string): void {
  if (PROTECTED_BRANCH_NAMES.has(branch.toLowerCase())) {
    throw new Error(
      `Branch "${branch}" is protected. The bot can only push to new branches. ` +
        `Create a new branch with a descriptive name (e.g. feat/my-change).`,
    );
  }
}

// --- GitLab API helpers ---

async function gitlabGet(
  endpoint: string,
  params: Record<string, string | number | undefined> = {},
): Promise<unknown> {
  const token = getToken();
  const url = new URL(`${GITLAB_URL}/api/v4/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { 'PRIVATE-TOKEN': token },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitLab API error ${res.status}: ${body}`);
  }

  return res.json();
}

async function gitlabPost(endpoint: string, body: unknown): Promise<unknown> {
  const token = getToken();
  const res = await fetch(`${GITLAB_URL}/api/v4/${endpoint}`, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API error ${res.status}: ${text}`);
  }

  return res.json();
}

function encodeProject(projectPath: string): string {
  return encodeURIComponent(projectPath);
}

// --- MCP Server ---

const server = new McpServer({ name: 'gitlab', version: '1.0.0' });

// List accessible projects
server.tool(
  'gitlab_list_projects',
  'List GitLab projects the bot has access to.',
  {
    search: z.string().optional().describe('Filter projects by name'),
  },
  async ({ search }) => {
    const data = await gitlabGet('projects', {
      membership: 'true',
      per_page: 50,
      search,
    }) as Array<{ path_with_namespace: string; description: string; default_branch: string; web_url: string }>;

    if (data.length === 0) return { content: [{ type: 'text' as const, text: 'No projects found.' }] };

    const lines = data.map(
      (p) => `• ${p.path_with_namespace} [${p.default_branch}]\n  ${p.web_url}`,
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// Clone a project
server.tool(
  'gitlab_clone_project',
  'Clone a GitLab project into the shared projects directory. Use this before reading or editing files locally.',
  {
    project_path: z.string().describe('GitLab project path, e.g. "myorg/myrepo"'),
    branch: z.string().optional().describe('Branch to checkout (default: default branch)'),
  },
  async ({ project_path, branch }) => {
    const token = getToken();
    const repoName = project_path.split('/').pop()!;
    const targetDir = `${PROJECTS_DIR}/${repoName}`;
    const cloneUrl = `${GITLAB_URL.replace('://', `://oauth2:${token}@`)}/${project_path}.git`;

    const { stdout: lsOut } = await execFileAsync('ls', [PROJECTS_DIR]).catch(() => ({ stdout: '' }));
    if (lsOut.split('\n').includes(repoName)) {
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
      await execFileAsync('git', ['-c', 'http.proxy=', 'fetch', '--all'], { cwd: targetDir, env: gitEnv });
      if (branch) await execFileAsync('git', ['checkout', branch], { cwd: targetDir, env: gitEnv });
      return {
        content: [{ type: 'text' as const, text: `Already cloned. Fetched latest at ${targetDir}${branch ? ` (branch: ${branch})` : ''}.` }],
      };
    }

    const cloneArgs = ['-c', 'http.proxy=', 'clone', cloneUrl, targetDir];
    if (branch) cloneArgs.push('--branch', branch);
    await execFileAsync('git', cloneArgs, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });

    return {
      content: [{ type: 'text' as const, text: `Cloned ${project_path} to ${targetDir}${branch ? ` (branch: ${branch})` : ''}.` }],
    };
  },
);

// List branches
server.tool(
  'gitlab_list_branches',
  'List branches in a GitLab project.',
  {
    project_path: z.string().describe('GitLab project path'),
    search: z.string().optional().describe('Filter branches by name'),
  },
  async ({ project_path, search }) => {
    const data = await gitlabGet(
      `projects/${encodeProject(project_path)}/repository/branches`,
      { search, per_page: 50 },
    ) as Array<{ name: string; default: boolean; protected: boolean; commit: { short_id: string; authored_date: string } }>;

    const lines = data.map(
      (b) => `• ${b.name}${b.default ? ' [default]' : ''}${b.protected ? ' [protected]' : ''} — ${b.commit.short_id} (${b.commit.authored_date.slice(0, 10)})`,
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No branches found.' }] };
  },
);

// Create a new branch
server.tool(
  'gitlab_create_branch',
  'Create a new branch in a GitLab project. Blocked for main and master.',
  {
    project_path: z.string().describe('GitLab project path'),
    branch: z.string().describe('New branch name'),
    ref: z.string().describe('Source branch or commit SHA to branch from'),
  },
  async ({ project_path, branch, ref }) => {
    assertNotProtectedBranch(branch);

    await gitlabPost(
      `projects/${encodeProject(project_path)}/repository/branches`,
      { branch, ref },
    );

    return {
      content: [{ type: 'text' as const, text: `Branch "${branch}" created from "${ref}" in ${project_path}.` }],
    };
  },
);

// Read a file
server.tool(
  'gitlab_read_file',
  'Read a file from a GitLab repository via the API (no clone needed).',
  {
    project_path: z.string().describe('GitLab project path'),
    file_path: z.string().describe('File path in the repository, e.g. "src/index.ts"'),
    ref: z.string().optional().describe('Branch, tag, or commit SHA (default: HEAD)'),
  },
  async ({ project_path, file_path, ref }) => {
    const data = await gitlabGet(
      `projects/${encodeProject(project_path)}/repository/files/${encodeURIComponent(file_path)}`,
      { ref: ref || 'HEAD' },
    ) as { content: string; encoding: string; file_name: string; last_commit_id: string };

    const content =
      data.encoding === 'base64'
        ? Buffer.from(data.content, 'base64').toString('utf-8')
        : data.content;

    return {
      content: [{ type: 'text' as const, text: `// ${data.file_name} (commit: ${data.last_commit_id})\n\n${content}` }],
    };
  },
);

// Commit files via API
server.tool(
  'gitlab_commit_files',
  'Commit one or more file changes to a branch via the GitLab API. Blocked for main and master.',
  {
    project_path: z.string().describe('GitLab project path'),
    branch: z.string().describe('Target branch — must not be main or master'),
    commit_message: z.string().describe('Commit message'),
    files: z.array(
      z.object({
        action: z.enum(['create', 'update', 'delete', 'move']).describe('File action'),
        file_path: z.string().describe('File path in the repo'),
        content: z.string().optional().describe('File content (for create/update)'),
        previous_path: z.string().optional().describe('Previous path (for move)'),
      }),
    ).describe('List of file changes'),
  },
  async ({ project_path, branch, commit_message, files }) => {
    assertNotProtectedBranch(branch);

    const result = await gitlabPost(
      `projects/${encodeProject(project_path)}/repository/commits`,
      {
        branch,
        commit_message,
        actions: files.map((f) => ({ ...f, encoding: 'text' })),
      },
    ) as { short_id: string; title: string; web_url: string };

    return {
      content: [{ type: 'text' as const, text: `Committed to "${branch}": ${result.short_id} — ${result.title}\n${result.web_url}` }],
    };
  },
);

// List commits
server.tool(
  'gitlab_list_commits',
  'List commits in a project. Can filter by branch, author, or date range.',
  {
    project_path: z.string().describe('GitLab project path'),
    ref_name: z.string().optional().describe('Branch or tag name (default: default branch)'),
    author: z.string().optional().describe('Filter by author name or email'),
    since: z.string().optional().describe('ISO 8601 date — only commits after this, e.g. "2024-01-01T00:00:00Z"'),
    until: z.string().optional().describe('ISO 8601 date — only commits before this'),
    per_page: z.number().optional().describe('Number of commits to return (default: 20, max: 100)'),
  },
  async ({ project_path, ref_name, author, since, until, per_page }) => {
    const data = await gitlabGet(
      `projects/${encodeProject(project_path)}/repository/commits`,
      { ref_name, author, since, until, per_page: per_page || 20 },
    ) as Array<{ short_id: string; title: string; author_name: string; authored_date: string; web_url: string }>;

    if (data.length === 0) return { content: [{ type: 'text' as const, text: 'No commits found.' }] };

    const lines = data.map(
      (c) => `• ${c.short_id} ${c.authored_date.slice(0, 10)} [${c.author_name}] ${c.title}\n  ${c.web_url}`,
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// Get a specific commit
server.tool(
  'gitlab_get_commit',
  'Get details and diff of a specific commit.',
  {
    project_path: z.string().describe('GitLab project path'),
    sha: z.string().describe('Commit SHA'),
  },
  async ({ project_path, sha }) => {
    const [commit, diff] = await Promise.all([
      gitlabGet(`projects/${encodeProject(project_path)}/repository/commits/${sha}`) as Promise<{
        id: string; short_id: string; title: string; message: string;
        author_name: string; author_email: string; authored_date: string;
        stats: { additions: number; deletions: number };
        web_url: string;
      }>,
      gitlabGet(`projects/${encodeProject(project_path)}/repository/commits/${sha}/diff`) as Promise<
        Array<{ old_path: string; new_path: string; diff: string }>
      >,
    ]);

    const diffText = diff.slice(0, 10)
      .map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`)
      .join('\n\n');

    const text = [
      `Commit: ${commit.id}`,
      `Author: ${commit.author_name} <${commit.author_email}>`,
      `Date: ${commit.authored_date}`,
      `Message: ${commit.message.trim()}`,
      `Stats: +${commit.stats.additions} -${commit.stats.deletions}`,
      `URL: ${commit.web_url}`,
      `\n--- Diff ---\n`,
      diffText,
    ].join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

// List MRs
server.tool(
  'gitlab_list_mrs',
  'List merge requests in a project.',
  {
    project_path: z.string().describe('GitLab project path'),
    state: z.enum(['opened', 'closed', 'merged', 'all']).optional().describe('MR state (default: opened)'),
    author_username: z.string().optional().describe('Filter by author username'),
    target_branch: z.string().optional().describe('Filter by target branch'),
    per_page: z.number().optional().describe('Number of MRs to return (default: 20)'),
  },
  async ({ project_path, state, author_username, target_branch, per_page }) => {
    const data = await gitlabGet(
      `projects/${encodeProject(project_path)}/merge_requests`,
      { state: state || 'opened', author_username, target_branch, per_page: per_page || 20 },
    ) as Array<{
      iid: number; title: string; state: string;
      author: { name: string }; source_branch: string; target_branch: string;
      created_at: string; web_url: string;
    }>;

    if (data.length === 0) return { content: [{ type: 'text' as const, text: 'No merge requests found.' }] };

    const lines = data.map(
      (mr) => `• !${mr.iid} [${mr.state}] ${mr.title}\n  ${mr.source_branch} → ${mr.target_branch} | ${mr.author.name} | ${mr.created_at.slice(0, 10)}\n  ${mr.web_url}`,
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  },
);

// Get a specific MR
server.tool(
  'gitlab_get_mr',
  'Get details, description, and diff of a specific merge request.',
  {
    project_path: z.string().describe('GitLab project path'),
    mr_iid: z.number().describe('Merge request IID (the number shown as !123)'),
  },
  async ({ project_path, mr_iid }) => {
    const [mr, changes] = await Promise.all([
      gitlabGet(`projects/${encodeProject(project_path)}/merge_requests/${mr_iid}`) as Promise<{
        iid: number; title: string; description: string; state: string;
        author: { name: string; username: string };
        source_branch: string; target_branch: string;
        created_at: string; updated_at: string;
        merge_status: string; web_url: string; changes_count: string;
      }>,
      gitlabGet(`projects/${encodeProject(project_path)}/merge_requests/${mr_iid}/changes`) as Promise<{
        changes: Array<{ old_path: string; new_path: string; diff: string }>;
      }>,
    ]);

    const diffText = changes.changes.slice(0, 10)
      .map((c) => `--- ${c.old_path}\n+++ ${c.new_path}\n${c.diff}`)
      .join('\n\n');

    const text = [
      `MR !${mr.iid}: ${mr.title}`,
      `State: ${mr.state} | ${mr.merge_status}`,
      `Author: ${mr.author.name} (@${mr.author.username})`,
      `Branch: ${mr.source_branch} → ${mr.target_branch}`,
      `Created: ${mr.created_at.slice(0, 10)} | Updated: ${mr.updated_at.slice(0, 10)}`,
      `Changes: ${mr.changes_count} files`,
      `URL: ${mr.web_url}`,
      `\n--- Description ---\n${mr.description || '(no description)'}`,
      `\n--- Diff (first 10 files) ---\n${diffText}`,
    ].join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

// Create MR
server.tool(
  'gitlab_create_mr',
  'Open a merge request from a source branch to a target branch.',
  {
    project_path: z.string().describe('GitLab project path'),
    source_branch: z.string().describe('Branch with your changes'),
    target_branch: z.string().describe('Branch to merge into (e.g. main)'),
    title: z.string().describe('MR title'),
    description: z.string().optional().describe('MR description (supports markdown)'),
  },
  async ({ project_path, source_branch, target_branch, title, description }) => {
    const result = await gitlabPost(
      `projects/${encodeProject(project_path)}/merge_requests`,
      { source_branch, target_branch, title, description },
    ) as { iid: number; web_url: string };

    return {
      content: [{ type: 'text' as const, text: `MR !${result.iid} created: ${title}\n${result.web_url}` }],
    };
  },
);

// Add comment to MR or issue
server.tool(
  'gitlab_add_comment',
  'Add a comment to a merge request or issue.',
  {
    project_path: z.string().describe('GitLab project path'),
    type: z.enum(['mr', 'issue']).describe('Whether to comment on an MR or an issue'),
    iid: z.number().describe('MR or issue IID'),
    body: z.string().describe('Comment text (supports markdown)'),
  },
  async ({ project_path, type, iid, body }) => {
    const endpoint = type === 'mr'
      ? `projects/${encodeProject(project_path)}/merge_requests/${iid}/notes`
      : `projects/${encodeProject(project_path)}/issues/${iid}/notes`;

    const result = await gitlabPost(endpoint, { body }) as { id: number };

    return {
      content: [{ type: 'text' as const, text: `Comment added (id: ${result.id}).` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
