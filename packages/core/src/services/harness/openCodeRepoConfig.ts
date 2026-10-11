import * as path from 'path';
import {
  isRecord, parseJsonc, readText, repoLevels,
  type InstructionFile, type ProjectMcpServer, type ProjectServers, type RepoConfigReader,
} from './repoConfig';

/** Where OpenCode reads a directory's config, in the order it layers them (checked against 1.18.35 and 2.0.26). */
const CONFIG_FILES = ['opencode.json', 'opencode.jsonc', path.join('.opencode', 'opencode.json'), path.join('.opencode', 'opencode.jsonc')];

/** OpenCode's instruction files: the first name found anywhere from the workspace up wins, at every level it is found. */
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];

function server(name: string, entry: unknown, source: string): ProjectMcpServer | string | null {
  if (!isRecord(entry)) return 'not an object';
  if (entry.enabled === false) return null;
  if (entry.type === 'remote') {
    if (typeof entry.url !== 'string') return 'no url';
    return { name, source, transport: 'remote', target: entry.url, names: isRecord(entry.headers) ? Object.keys(entry.headers) : [], definition: entry };
  }
  const command = Array.isArray(entry.command) ? entry.command.map(String) : [];
  if (entry.type !== 'local' || command.length === 0) return 'no command or url';
  return { name, source, transport: 'stdio', target: command.join(' '), names: isRecord(entry.environment) ? Object.keys(entry.environment) : [], definition: entry };
}

export const OPENCODE_REPO_CONFIG: RepoConfigReader = {
  instructions(workspace) {
    const levels = repoLevels(workspace);
    for (const name of INSTRUCTION_NAMES) {
      const files: InstructionFile[] = levels.flatMap((dir) => {
        const text = readText(path.join(dir, name));
        return text === undefined ? [] : [{ path: path.relative(workspace, path.join(dir, name)) || name, text }];
      });
      if (files.length > 0) return files;
    }
    return [];
  },

  /** Every level's config, the one nearer the workspace winning for a server both name. */
  projectServers(workspace) {
    const byName = new Map<string, ProjectMcpServer>();
    const unreadable: ProjectServers['unreadable'] = [];
    for (const dir of repoLevels(workspace)) {
      for (const name of CONFIG_FILES) {
        const file = path.join(dir, name);
        const text = readText(file);
        if (text === undefined) continue;
        const source = path.relative(workspace, file);
        let parsed: unknown;
        try { parsed = parseJsonc(text); } catch (err) {
          unreadable.push({ source, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const entries = isRecord(parsed) && isRecord(parsed.mcp) ? parsed.mcp : {};
        for (const [serverName, entry] of Object.entries(entries)) {
          const read = server(serverName, entry, source);
          if (typeof read === 'string') unreadable.push({ source: `${source} (${serverName})`, reason: read });
          else if (read) byName.set(serverName, read);
          else byName.delete(serverName);
        }
      }
    }
    return { servers: [...byName.values()], unreadable };
  },
};
