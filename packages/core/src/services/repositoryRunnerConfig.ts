/** Select repository-root runner configuration from repository-relative changed paths. */
export function repositoryRunnerConfigPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(path =>
    // Project MCP servers start commands or send data to a repository-chosen URL.
    path === '.mcp.json' ||
    // Settings can run hooks and helpers, load plugins, or redirect traffic.
    path === '.claude/settings.json' ||
    // Local settings have the same execution capabilities as project settings.
    path === '.claude/settings.local.json' ||
    // Hook files provide commands invoked by the runner.
    path.startsWith('.claude/hooks/') ||
    // Plugin files can provide code and hooks loaded by the runner.
    path.startsWith('.claude/plugins/') ||
    // Plugin metadata can load plugins and their executable components.
    path.startsWith('.claude-plugin/') ||
    // Plugin and marketplace manifests can select code for the runner to load.
    /^\.claude\/(?:[^/]+\/)*(?:plugin|marketplace)\.json$/.test(path)
  ))].sort();
}
