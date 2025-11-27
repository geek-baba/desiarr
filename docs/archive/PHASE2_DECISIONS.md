# Phase 2 Implementation Decisions

## Decision 1: Release Flattening

### Your Preference: Keep Separate ✅
**My Recommendation: Keep Separate (Agree)**

**Reasoning:**
- **Functionality**: Your categorization (`add`, `existing`, `upgrade`, `ignored`) is **business logic** that users understand
- **Visual Clarity**: Users can quickly see:
  - "This movie has 3 releases ready to add" (green section)
  - "This movie has 1 upgrade available" (orange section)
  - "This movie has 2 ignored releases" (gray section)
- **Action Clarity**: Different actions per category (Add vs Upgrade vs Ignore)
- **Preserves Logic**: No need to re-categorize on the frontend

**Visual Approach:**
- Show releases in **one unified table** but with **visual grouping**:
  - Color-coded row backgrounds (green for add, blue for existing, orange for upgrade, gray for ignored)
  - Optional: Section headers within table ("Add Releases", "Upgrade Releases", etc.)
  - Or: Separate tables per category (cleaner, but more vertical space)

**My Recommendation**: **One table with color-coded rows** - best balance of clarity and space efficiency.

---

## Decision 2: Movie-Level Decision Badge

### Your Suggestion: "Even if one eligible release exists, mark movie approved" ✅
**My Recommendation: Priority-Based Decision Logic**

**Decision Logic:**
```javascript
if (movie.add.length > 0) {
  decision = 'APPROVED';  // Green badge
  reason = `${movie.add.length} new release(s) available`;
} else if (movie.upgrade.length > 0) {
  decision = 'UPGRADE';   // Orange badge
  reason = `${movie.upgrade.length} upgrade candidate(s)`;
} else if (movie.existing.length > 0) {
  decision = 'EXISTING';  // Blue badge
  reason = 'Already in Radarr';
} else if (movie.ignored.length > 0) {
  decision = 'IGNORED';   // Gray badge
  reason = 'All releases ignored (doesn\'t meet requirements)';
} else {
  decision = 'PENDING';   // Yellow badge
  reason = 'No releases found';
}
```

**Visual:**
- Badge color matches priority (green = highest priority action available)
- Tooltip shows reason (e.g., "3 new releases available")
- Badge appears next to movie title in card header

**My Recommendation**: ✅ **Agree with your approach** - if ANY eligible release exists, show APPROVED. This makes it clear the movie has actionable releases.

---

## Decision 3: Mobile Filters

### My Preference: Sheet/Drawer ✅

**Reasoning:**
- **Better UX**: Filters are still accessible on mobile (just hidden by default)
- **Consistent Pattern**: Matches modern app patterns (Gmail, Twitter, etc.)
- **No Functionality Loss**: Users can still filter on mobile
- **Easy Implementation**: Use a Sheet component (slide-in from right/bottom)

**Implementation:**
- Desktop (≥1024px): Right rail visible, sticky
- Mobile (<1024px): 
  - Hide right rail
  - Add "Filters" button in header (next to refresh)
  - Click opens Sheet/Drawer from right side
  - Sheet contains all filters
  - Close button or swipe to dismiss

**Alternative (Hide Completely):**
- Pros: Simpler, less code
- Cons: Filters unavailable on mobile (bad UX)

**My Recommendation**: ✅ **Sheet/Drawer** - better UX, worth the extra code.

---

## Decision 4: Priority

### Your Preference: Visual Upgrade First ✅
**My Recommendation: Agree - Phased Approach**

**Phase 2.1 (Week 1): Visual Upgrade**
- Premium movie cards with new design
- Release tables with better styling
- Dark mode support
- Keep all existing functionality
- **Deliverable**: Beautiful dashboard that works exactly as before

**Phase 2.2 (Week 2): Filters & Functionality**
- Right rail filters panel
- Client-side filtering
- Mobile sheet for filters
- **Deliverable**: Functional filtering

**Phase 2.3 (Week 3): Polish & Advanced**
- Search chips
- State persistence
- Skeleton loaders
- Toasts
- Keyboard shortcuts
- **Deliverable**: Polished, production-ready dashboard

**My Recommendation**: ✅ **Agree** - Visual first, then functionality, then polish.

---

## Final Decisions Summary

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| **Release Flattening** | ✅ **Keep Separate** | Preserves business logic, clearer categorization |
| **Visual Approach** | **One table, color-coded rows** | Best balance of clarity and space |
| **Movie Decision** | ✅ **Priority-based** (add > upgrade > existing > ignored) | Clear action priority |
| **Mobile Filters** | ✅ **Sheet/Drawer** | Better UX, filters still accessible |
| **Priority** | ✅ **Visual → Functionality → Polish** | Incremental, low-risk approach |

---

## Implementation Plan Based on Decisions

### Phase 2.1: Visual Upgrade (Week 1)

**Goal**: Premium cards + tables, keep all functionality

1. **Create New Movie Card Partial**
   - Accept your `movie` structure (with `add`, `existing`, `upgrade`, `ignored`)
   - Show movie header: poster, title, year, language, decision badge, IMDB/TMDB links
   - Decision badge logic: Priority-based (as above)
   - "Add to Radarr" button (primary action)

2. **Create Release Table Partial**
   - Accept all release arrays
   - Show in ONE table with color-coded rows:
     - Green background for `add` releases
     - Blue background for `existing` releases
     - Orange background for `upgrade` releases
   - Gray background for `ignored` releases
   - Columns: Source, Release Name, Attributes, Size, Status, Actions
   - Copy-to-clipboard for release names/links

3. **Update Dashboard**
   - Replace current `movie-card` partial with new one
   - Keep existing tab structure (New Movies, Existing Movies, Unmatched)
   - Keep time period tabs (Today, Yesterday, Older)
   - Add dark mode styling throughout

**Deliverable**: Beautiful dashboard that looks premium but works exactly as before.

---

### Phase 2.2: Filters & Functionality (Week 2)

**Goal**: Add filtering without breaking existing features

1. **Right Rail Filters Panel**
   - Language filter (dropdown)
   - Resolution filter (dropdown)
   - Status filter (dropdown: NEW, EXISTING, UPGRADE, IGNORED)
   - Source filter (text input)
   - Audio filter (text input)
   - Clear filters button

2. **Mobile Sheet/Drawer**
   - "Filters" button in header (mobile only)
   - Sheet slides in from right
   - Contains all filters
   - Close button

3. **Client-Side Filtering**
   - Add data attributes to movie cards
   - Filter by language, resolution, status, source, audio
   - Show/hide cards based on filters
   - Skeleton loader while filtering (180ms delay)

**Deliverable**: Functional filtering on desktop and mobile.

---

### Phase 2.3: Polish & Advanced (Week 3)

**Goal**: Production-ready polish

1. **Search Chips**
   - Parse global search for tokens (`lang:ta`, `2160p`, etc.)
   - Create removable chips
   - Apply filters when chips added/removed

2. **State Persistence**
   - URL query params (`?lang=ta&res=2160p`)
   - LocalStorage backup
   - Restore on page load

3. **UX Polish**
   - Skeleton loaders (enhanced)
   - Toast notifications (copy confirmations, filter feedback)
   - Keyboard shortcuts (A, ?, Cmd/Ctrl+K)
   - Copy-to-clipboard with proper icons

**Deliverable**: Polished, production-ready dashboard.

---

## Ready to Start?

With these decisions, I can now implement Phase 2.1 (Visual Upgrade) with:
- ✅ Premium cards adapted to your data structure
- ✅ Release tables with color-coded rows (keeping categories separate)
- ✅ Priority-based decision badges
- ✅ Dark mode support
- ✅ All existing functionality preserved

Should I proceed with Phase 2.1 implementation? 🚀

