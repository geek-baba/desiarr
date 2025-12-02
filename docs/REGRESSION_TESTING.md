# Regression Testing Guide

## Overview

This document outlines a systematic approach to prevent regressions when making changes to the codebase. The goal is to catch breaking changes before they reach production.

## Pre-Commit Checklist

Before committing any changes, verify the following:

### 1. TypeScript Compilation
```bash
npm run build
```
- Must complete without errors
- All type errors must be resolved

### 2. Linting
```bash
npm run lint
```
- Must pass all linting rules
- Fix all warnings and errors

### 3. Manual Smoke Tests

#### Core Pages (Must Work)
- [ ] `/dashboard` - Main dashboard loads
- [ ] `/movies` - Movies view loads
- [ ] `/tv` - TV shows view loads
- [ ] `/data/rss` - RSS data page loads
- [ ] `/data/releases` - Movie releases page loads
- [ ] `/data/tv-releases` - TV releases page loads
- [ ] `/data/radarr` - Radarr data page loads
- [ ] `/settings` - Settings page loads

#### Critical Functionality (Must Work)
- [ ] **RSS Data Page** (`/data/rss`):
  - [ ] Global search filters items
  - [ ] "Match" button opens modal
  - [ ] "Override TMDB" button works
  - [ ] "Override IMDB" button works
  - [ ] "Override TVDB" button works (for TV items)
  - [ ] Search in match modal returns results
  - [ ] Apply match updates the item
- [ ] **Dashboard**:
  - [ ] Sync & Match button works
  - [ ] Movie cards display correctly
  - [ ] TV show cards display correctly
  - [ ] Language badges display correctly
  - [ ] Radarr Data section displays correctly
- [ ] **Settings**:
  - [ ] Can save Radarr API config
  - [ ] Can save Sonarr API config
  - [ ] Can save TMDB API key
  - [ ] Can manage RSS feeds

### 4. Cross-Module Impact Check

When modifying shared modules, check all consumers:

#### `src/tmdb/client.ts`
- [ ] `src/routes/dashboard.ts` - Uses `new TMDBClient()`
- [ ] `src/routes/data.ts` - Uses default export `tmdbClient`
- [ ] Any other files importing TMDB client

#### `src/routes/dashboard.ts`
- [ ] Movie grouping logic
- [ ] TV show grouping logic
- [ ] Language mapping
- [ ] Title extraction
- [ ] Radarr data extraction

#### Shared JavaScript Functions
- [ ] `showToast()` - Used in: dashboard.ejs, rss-data.ejs, log-explorer.ejs
- [ ] `showConfirm()` - Used in: dashboard.ejs, rss-data.ejs, log-explorer.ejs
- [ ] Any other shared UI functions

### 5. Database Schema Changes

If modifying database schema:
- [ ] Migration script added
- [ ] Migration runs on existing data
- [ ] Backward compatibility considered
- [ ] No breaking queries

## Automated Testing Strategy

### Current State
- No automated tests exist
- All testing is manual

### Recommended Approach

#### Phase 1: Critical Path Tests (Manual)
Create a checklist document that must be verified before each deployment:
- Core pages load
- Critical buttons work
- API endpoints respond

#### Phase 2: Integration Tests (Future)
- Use Playwright or Cypress for E2E tests
- Test critical user flows:
  - RSS sync → Match → Add to Radarr
  - Manual override → Dashboard update
  - Settings save → API connection

#### Phase 3: Unit Tests (Future)
- Test matching engines
- Test title parsing
- Test language mapping
- Test API clients

## Regression Prevention Workflow

### Before Making Changes

1. **Identify Impact Scope**
   - List all files that will be modified
   - List all files that import/use modified files
   - List all pages/routes that use modified code

2. **Create Test Plan**
   - Document current behavior
   - List test cases to verify after change

### During Development

1. **Incremental Changes**
   - Make small, focused changes
   - Test after each change
   - Commit working state frequently

2. **Check Dependencies**
   - Verify imports still work
   - Verify exports match usage
   - Check for circular dependencies

### After Making Changes

1. **Build & Lint**
   ```bash
   npm run build
   npm run lint
   ```

2. **Manual Smoke Test**
   - Run through pre-commit checklist
   - Test affected pages
   - Test related functionality

3. **Cross-Browser Check** (if UI changes)
   - Chrome/Edge
   - Firefox
   - Safari (if available)

4. **Review Changes**
   - Check git diff for unintended changes
   - Verify no debug code left behind
   - Verify no console.logs in production code

## Common Regression Patterns

### 1. Export/Import Mismatches
**Symptom**: `TypeError: X is not a function` or `Cannot read property of undefined`

**Prevention**:
- When changing exports, search for all imports
- Use TypeScript to catch type mismatches
- Test imports in isolation

**Example**: Changing `export default new TMDBClient()` to `export class TMDBClient` breaks `import tmdbClient from '../tmdb/client'`

### 2. Missing Function Definitions
**Symptom**: `ReferenceError: showToast is not defined`

**Prevention**:
- When adding shared functions, check all pages that need them
- Create a shared JavaScript file for common functions
- Document function dependencies

**Example**: Adding `showToast()` to dashboard.ejs but not rss-data.ejs

### 3. Database Schema Changes
**Symptom**: `SQLITE_ERROR: no such column: X`

**Prevention**:
- Always add migrations
- Test migrations on sample data
- Check all queries that use modified tables

### 4. API Client Changes
**Symptom**: API calls fail silently or return wrong data

**Prevention**:
- Check all usages of modified API client
- Verify method signatures match
- Test with real API responses

### 5. Route Handler Changes
**Symptom**: 404 errors or wrong responses

**Prevention**:
- Check route registration
- Verify request/response types
- Test with actual HTTP requests

## Quick Regression Test Script

Create a simple script to verify critical paths:

```bash
#!/bin/bash
# scripts/regression-test.sh

echo "Running regression tests..."

# Build check
echo "1. Building..."
npm run build || exit 1

# Lint check
echo "2. Linting..."
npm run lint || exit 1

# Check for common issues
echo "3. Checking for common issues..."

# Check for undefined functions in EJS files
grep -r "showToast\|showConfirm" views/*.ejs | while read line; do
  file=$(echo $line | cut -d: -f1)
  func=$(echo $line | grep -oE "(showToast|showConfirm)")
  if ! grep -q "function $func" "$file"; then
    echo "WARNING: $func used in $file but not defined"
  fi
done

# Check for missing exports
echo "4. Checking exports..."
# Add checks for critical exports

echo "Regression tests complete!"
```

## Deployment Checklist

Before deploying to production:

- [ ] All pre-commit checks pass
- [ ] Manual smoke tests pass
- [ ] No console errors in browser
- [ ] Database migrations tested
- [ ] API credentials configured
- [ ] Environment variables set
- [ ] Docker image builds successfully
- [ ] Container starts without errors
- [ ] Health check endpoint responds

## Post-Deployment Verification

After deployment:

- [ ] Verify application starts
- [ ] Check application logs for errors
- [ ] Test critical user flows
- [ ] Monitor error rates
- [ ] Check database connectivity
- [ ] Verify external API connections

## Continuous Improvement

- Document new regression patterns as they're discovered
- Update this guide with new test cases
- Add automated tests for frequently broken features
- Review and update checklists regularly

