# Broken Links Checker

Checks absolute HTTP/HTTPS links in your source during CI.

## Features
- Scans `**/*.{html,htm,cshtml,razor,vue,jsx,tsx,svelte,md}`
- Ignores relative links
- URL ignore patterns with wildcards (`example.com/*`, `*.local/*`)
- Configurable allowed status codes, timeout, and concurrency
- Fail the build on broken links or emit warnings

## Usage (YAML)
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
    failOnBroken: true
    concurrency: 16
    timeoutMs: 10000
    allowedStatus: 200-299,301,302,307,308
