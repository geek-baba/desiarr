# Development Strategy: Preventing Regressions

## Executive Summary

This document outlines a **practical, incremental testing and development strategy** to prevent breaking existing features while maintaining development velocity. We balance **automated checks** with **targeted manual testing** rather than full TDD, which would be overkill for this codebase size.

---

## 1. How to Not Break Existing Features

### A. Pre-Development: Impact Analysis

**Before writing any code**, answer these questions:

1. **What files will I modify?**
   - List all files that will change
   - Identify shared modules/utilities

2. **What depends on what I'm changing?**
   - Use `grep` to find all imports/usages
   - Check `docs/CODE-NAV.md` for module relationships
   - Review `docs/REGRESSION_TESTING.md` cross-module impact section

3. **What pages/routes use this code?**
   - Map backend routes to frontend pages
   - Identify JavaScript functions used across pages

4. **What's the risk level?**
   - **Low**: Adding new feature in isolated module
   - **Medium**: Modifying shared utility or route handler
   - **High**: Changing database schema, API client, or core matching logic

### B. During Development: Incremental Changes

**Principle**: Make small, focused changes and test frequently.

1. **One logical change per commit**
   - Don't mix bug fixes with features
   - Don't mix refactoring with new functionality
   - Makes rollback easier

2. **Test after each change**
   - Run `npm run build` after every TypeScript change
   - Manually test affected pages after route changes
   - Check browser console for JavaScript errors

3. **Use feature flags for risky changes**
   - Add settings toggle for experimental features
   - Allows gradual rollout and easy disable

### C. Pre-Commit: Automated Checks

**Mandatory checks** (must pass before commit):

```bash
# 1. TypeScript compilation
npm run build

# 2. Linting (when we add it)
npm run lint

# 3. Quick smoke test (manual)
# - Start dev server: npm run dev
# - Visit affected pages
# - Check browser console for errors
```

### D. Pre-Merge: Regression Testing

**Use the checklist in `docs/REGRESSION_TESTING.md`**:

1. **Build & Lint** ✅
2. **Manual Smoke Tests** (core pages)
3. **Critical Functionality Tests** (affected features)
4. **Cross-Module Impact Check** (if modifying shared code)

### E. Post-Deployment: Monitoring

1. **Check application logs** for errors
2. **Monitor browser console** on affected pages
3. **Verify critical user flows** still work
4. **Rollback plan** ready if issues found

---

## 2. Do We Need Test-Driven Development (TDD)?

### Recommendation: **No, but with caveats**

**Why not full TDD:**
- Small codebase (~3,000 lines)
- Single developer/maintainer
- Rapid iteration needs
- EJS templates hard to unit test
- External API dependencies (Radarr, Sonarr, TMDB)
- Database-heavy operations

**What we should do instead:**

### A. **Targeted Unit Tests** (High-Value Areas)

Focus testing on **pure functions** and **business logic** that:
- Have complex logic
- Are used in multiple places
- Are hard to test manually
- Have caused bugs before

**Priority areas:**
1. **Title parsing** (`src/scoring/parseFromTitle.ts`)
   - Complex regex patterns
   - Used everywhere
   - Bugs cause wrong matches

2. **Language mapping** (`src/routes/dashboard.ts` - language functions)
   - Multiple edge cases
   - Used for display logic
   - Recent bug source

3. **Matching engine scoring** (`src/services/matchingEngine.ts`)
   - Core business logic
   - Hard to test manually
   - Bugs cause wrong matches

4. **Database migrations** (`src/db/index.ts`)
   - Schema changes are risky
   - Need to verify on real data

### B. **Integration Tests** (Critical Paths)

Test **end-to-end flows** that users actually use:

1. **RSS Sync → Match → Dashboard Display**
   - Feed sync works
   - Matching engine runs
   - Dashboard shows results

2. **Manual Override → Dashboard Update**
   - Override ID in RSS page
   - Dashboard reflects change
   - Matching respects override

3. **Settings Save → API Connection**
   - Save Radarr API config
   - Sync works with new config

### C. **Smoke Tests** (Automated Page Checks)

Use **Playwright** or **Puppeteer** to:
- Verify pages load without errors
- Check for JavaScript console errors
- Verify critical buttons exist and are clickable
- **Not testing functionality**, just "doesn't break"

---

## 3. Proposed Implementation Plan

### Phase 1: Foundation (Week 1)

**Goal**: Set up minimal testing infrastructure without slowing development.

#### 1.1 Add Testing Framework

```bash
npm install -D vitest @vitest/ui
```

**Why Vitest:**
- Fast (uses Vite)
- TypeScript support out of the box
- Good for Node.js projects
- Can test TypeScript directly

#### 1.2 Create Test Structure

```
tests/
  unit/
    scoring/
      parseFromTitle.test.ts
    routes/
      dashboard-language.test.ts
  integration/
    matching-flow.test.ts
  smoke/
    pages.test.ts
```

#### 1.3 Add Test Scripts

```json
{
  "scripts": {
    "test": "vitest",
    "test:watch": "vitest --watch",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage"
  }
}
```

#### 1.4 Write First Tests (High-Value)

Start with **title parsing** (most bug-prone):

```typescript
// tests/unit/scoring/parseFromTitle.test.ts
import { describe, it, expect } from 'vitest';
import { parseReleaseFromTitle } from '../../src/scoring/parseFromTitle';

describe('parseReleaseFromTitle', () => {
  it('should extract movie name and year', () => {
    const result = parseReleaseFromTitle('Vallamai.2025.1080p.SS.WEB-DL');
    expect(result.name).toBe('Vallamai');
    expect(result.year).toBe(2025);
  });

  it('should detect WEB-DL source', () => {
    const result = parseReleaseFromTitle('Movie.2025.1080p.AMZN.WEB-DL');
    expect(result.sourceTag).toBe('WEB-DL');
    expect(result.sourceSite).toBe('AMZN');
  });

  // Add more edge cases...
});
```

### Phase 2: Critical Path Coverage (Week 2)

**Goal**: Add tests for areas that have caused regressions.

#### 2.1 Language Mapping Tests

```typescript
// tests/unit/routes/dashboard-language.test.ts
import { describe, it, expect } from 'vitest';
import { getLanguageName, isIndianLanguage } from '../../src/routes/dashboard';

describe('Language Functions', () => {
  it('should convert ISO code to full name', () => {
    expect(getLanguageName('hi')).toBe('Hindi');
    expect(getLanguageName('ta')).toBe('Tamil');
  });

  it('should handle full names from Radarr', () => {
    expect(getLanguageName('Hindi')).toBe('Hindi');
    expect(isIndianLanguage('Hindi')).toBe(true);
  });

  // Test edge cases...
});
```

#### 2.2 Smoke Tests for Pages

```typescript
// tests/smoke/pages.test.ts
import { describe, it, expect } from 'vitest';
import { build } from 'vite';
// Use Playwright or Puppeteer to check pages load

describe('Page Smoke Tests', () => {
  it('should load dashboard without errors', async () => {
    // Start server, visit page, check console
  });

  it('should load RSS data page without errors', async () => {
    // Check for JavaScript errors
  });
});
```

### Phase 3: Integration Tests (Week 3)

**Goal**: Test critical user flows.

#### 3.1 Matching Flow Test

```typescript
// tests/integration/matching-flow.test.ts
describe('Matching Flow', () => {
  it('should sync RSS, run matching, and display results', async () => {
    // 1. Sync RSS feed
    // 2. Run matching engine
    // 3. Check dashboard shows results
  });
});
```

### Phase 4: CI Integration (Week 4)

**Goal**: Run tests automatically on every PR.

Add to `.github/workflows/`:
- Run `npm test` before Docker build
- Fail PR if tests fail
- Run smoke tests in CI environment

---

## 4. Development Workflow

### Standard Workflow

1. **Create feature branch**: `feature/name` or `fix/name`
2. **Make changes incrementally**
3. **Run `npm run build`** after each change
4. **Manually test affected pages**
5. **Run relevant tests**: `npm test -- parseFromTitle`
6. **Complete regression checklist** (from `REGRESSION_TESTING.md`)
7. **Commit with descriptive message**
8. **Push and create PR**
9. **CI runs tests automatically**
10. **Merge after review**

### For High-Risk Changes

1. **Write tests first** (TDD for this specific change)
2. **Implement change**
3. **Verify tests pass**
4. **Manual testing**
5. **Deploy to staging first** (if available)

---

## 5. Testing Philosophy

### What to Test

✅ **DO Test:**
- Pure functions (no side effects)
- Complex business logic
- Edge cases and error handling
- Database migrations
- Critical user flows

❌ **DON'T Test:**
- Simple getters/setters
- Express route handlers (test business logic instead)
- EJS template rendering (use smoke tests)
- External API calls (mock them)

### Test Coverage Goals

- **Phase 1**: 20% coverage (critical functions only)
- **Phase 2**: 40% coverage (add integration tests)
- **Phase 3**: 60% coverage (comprehensive unit tests)
- **Beyond**: Maintain 60-70% (don't chase 100%)

---

## 6. Tools & Scripts

### Pre-Commit Hook (Optional)

Create `.git/hooks/pre-commit`:

```bash
#!/bin/sh
npm run build || exit 1
npm test -- --run || exit 1
```

### Quick Test Script

Create `scripts/quick-test.sh`:

```bash
#!/bin/bash
# Quick regression test before commit

echo "🔍 Running quick tests..."

# Build check
npm run build || exit 1

# Run critical tests
npm test -- --run parseFromTitle || exit 1
npm test -- --run language || exit 1

# Check for common issues
echo "✅ Quick tests passed!"
```

---

## 7. Decision Matrix: When to Write Tests

| Change Type | Test Required? | Test Type |
|------------|----------------|-----------|
| New feature in isolated module | Optional | Unit test if complex |
| Bug fix | **Yes** | Unit test for the bug |
| Refactoring | **Yes** | Unit tests to verify behavior unchanged |
| Database schema change | **Yes** | Migration test + integration test |
| API client change | **Yes** | Integration test |
| UI change (EJS) | No | Manual testing + smoke test |
| Shared utility change | **Yes** | Unit tests for all edge cases |
| Matching engine change | **Yes** | Integration test |

---

## 8. Success Metrics

**Short-term (1 month):**
- Zero regressions in production
- 20% test coverage on critical functions
- All PRs include regression checklist completion

**Medium-term (3 months):**
- 40% test coverage
- Automated smoke tests in CI
- Integration tests for critical flows

**Long-term (6 months):**
- 60% test coverage
- Full CI/CD with automated testing
- Confidence in refactoring

---

## 9. Immediate Next Steps

1. ✅ **Already done**: Created `docs/REGRESSION_TESTING.md`
2. **Next**: Add Vitest and write first test (title parsing)
3. **Then**: Add smoke tests for pages
4. **Finally**: Integrate into CI

---

## 10. FAQ

**Q: Why not full TDD?**
A: TDD is great for large teams and complex systems. For a small, rapidly-evolving codebase, targeted testing is more practical.

**Q: What if I don't have time to write tests?**
A: At minimum, complete the regression checklist. Tests are required for high-risk changes (see Decision Matrix).

**Q: How do I test EJS templates?**
A: Don't unit test templates. Use smoke tests to verify pages load, and test the data preparation logic in route handlers.

**Q: What about testing external APIs?**
A: Mock them in tests. Use real APIs only in integration tests with test accounts.

**Q: Should I test everything?**
A: No. Focus on critical paths and bug-prone areas. 60% coverage of important code is better than 100% coverage of trivial code.

---

## Summary

**Strategy**: **Pragmatic Testing** (not full TDD)
- Write tests for critical/bug-prone code
- Use regression checklists for everything
- Automate smoke tests
- Test incrementally as we go

**Goal**: Prevent regressions without slowing development velocity.

**Next Action**: Add Vitest and write first test for title parsing.

