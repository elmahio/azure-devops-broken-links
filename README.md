# Broken Links Checker for Azure DevOps

Scans source files for absolute `http/https` URLs and checks if they resolve. Optionally fails the build.

## Features
- Default file globs: `**/*.{html,htm,cshtml,razor,vue,jsx,tsx,svelte,md}`
- Ignores relative links
- File exclude globs
- URL ignore patterns with wildcards (e.g., `example.com/*`, `*.local/*`)
- Configurable allowed status codes and timeout
- Parallel requests with configurable concurrency
- Fail the build or emit warnings only

## YAML
```yaml
steps:
- task: BrokenLinksChecker@0
  inputs:
    includeGlobs: |
      **/*.{html,htm,cshtml,razor,vue,jsx,tsx,svelte,md}
    excludeFileGlobs: |
      **/node_modules/**
      **/dist/**
    ignoreUrlPatterns: |
      *.local/*
      example.com/*
      staging.elmah.io/*
    failOnBroken: true
    concurrency: 16
    timeoutMs: 10000
    allowedStatus: 200-299,301,302,307,308
```