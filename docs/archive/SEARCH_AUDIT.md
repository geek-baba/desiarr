# Global Search Bar Audit Report

## Current Status

### ✅ Working Pages
1. **Radarr Data** (`/data/radarr`)
   - Method: URL-based search (page reload)
   - Implementation: Simple, reliable
   - No JavaScript function dependencies

2. **RSS Data** (`/data/rss`)
   - Method: Client-side filtering via `window.filterTable()`
   - Implementation: Updates local search input, calls function
   - Works because function is accessible

### ❌ Not Working
1. **Dashboard** (`/` or `/dashboard`)
   - Method: Client-side filtering via `window.filterMovies()`
   - Problem: Function not accessible when search events fire

## Root Cause Analysis

### Script Loading Order Issue
```
Line 265: <script src="/js/ui.js"></script>  ← ui.js loads FIRST
...
Line 644: function filterMovies() { ... }     ← filterMovies defined LATER
```

**Problem**: 
- `ui.js` runs immediately when loaded (line 265)
- `filterMovies` is defined later in the same page (line 644)
- When `ui.js` tries to attach event listeners, `filterMovies` doesn't exist yet
- Even with retries, there's a race condition

### Function Exposure Issue
```javascript
function filterMovies() {
  window.filterMovies = filterMovies;  // Only exposed when function is CALLED
  // ... rest of function
}
```

**Problem**:
- Function only exposes itself to `window` when it's FIRST CALLED
- If no one calls it first, `window.filterMovies` remains undefined
- Event listeners check for `window.filterMovies` but it doesn't exist

## Comparison: Why Radarr/RSS Work

### Radarr Data
- No function dependency
- Just updates URL and reloads page
- Server-side filtering

### RSS Data  
- Function `filterTable()` is defined in the page
- Function is accessible when event fires
- No timing issues

## Solutions

### Option 1: Fix Script Order (Recommended)
Move `filterMovies` definition BEFORE `ui.js` loads, or expose it immediately:

```javascript
// At top of dashboard script, before ui.js
window.filterMovies = function() {
  // ... implementation
};
```

### Option 2: Use Event Delegation
Attach listener to document and check for function on each event:

```javascript
document.addEventListener('input', function(e) {
  if (e.target.id === 'globalSearch' && typeof window.filterMovies === 'function') {
    window.filterMovies();
  }
});
```

### Option 3: URL-Based Search (Like Radarr)
Change dashboard to use URL parameters and server-side filtering:
- More reliable
- Works consistently
- But loses real-time filtering

### Option 4: Inline Event Handler
Add `oninput` directly to the search input in the header partial:
- Simplest solution
- No timing issues
- But less clean architecture

## Recommended Fix

**Immediate Fix**: Expose `filterMovies` to window immediately when defined, not inside the function:

```javascript
// In dashboard.ejs, before the function definition
function filterMovies() {
  // ... implementation
}
// Expose immediately after definition
window.filterMovies = filterMovies;
```

**Better Fix**: Move function definition before ui.js loads, or use a different approach.

