# Broken Links Checker

Checks absolute HTTP/HTTPS links in your source during CI.

## Features
- Scans `html`, `cshtml`, `md`, or any other files including links.
- Ignores relative links.
- URL ignore patterns with wildcards (`example.com/*`, `*.local/*`)
- Configurable allowed status codes, timeout, and concurrency.
- Fail the build on broken links or emit warnings.

## Usage (YAML)

```yaml
steps:
- task: BrokenLinksChecker@0
  inputs:
    includeGlobs: |
      **/*.html
      **/*.htm
      **/*.cshtml
      **/*.razor
    excludeFileGlobs: |
      **/node_modules/**
      **/dist/**
    ignoreUrlPatterns: |
      *.local/*
      example.com/*
    failOnBroken: true
    concurrency: 16
    timeoutMs: 10000
    allowedStatus: 200-299
```

| Input | Description | Default |
|--------|--------------|----------|
| **includeGlobs** | File patterns to scan for links. Supports multiple lines. | `**/*.html`, `**/*.htm`, `**/*.cshtml`, `**/*.razor`, `**/*.vue`, `**/*.jsx`, `**/*.tsx`, `**/*.svelte`, `**/*.md` |
| **excludeFileGlobs** | Files or folders to skip, such as build output or dependencies. | *(none)* |
| **ignoreUrlPatterns** | Wildcard patterns for URLs that should never be checked (for example, local development hosts). | *(none)* |
| **failOnBroken** | When `true`, the pipeline step fails if any broken links are found. When `false`, only warnings are logged. | `false` |
| **concurrency** | Number of URLs to check in parallel. Higher values speed up execution but can increase network load. | `16` |
| **timeoutMs** | Per-request timeout in milliseconds. Links taking longer will be marked as broken. | `10000` |
| **allowedStatus** | Comma-separated list or ranges of HTTP status codes that count as successful. <br><br>Examples:<br>`200-299` - only treat 2xx responses as success (default).<br>`200-299,301,302` - also accept standard redirects.<br><br>The checker always follows redirects (up to 10 hops) and evaluates the final response. Listing redirect codes here simply marks intermediate 3xx responses as valid if encountered directly. | `200-299` |