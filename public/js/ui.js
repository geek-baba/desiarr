(function() {
  'use strict';

  const html = document.documentElement;
  const toggle = document.getElementById('darkModeToggle');
  const openSidebar = document.getElementById('openSidebar');
  const collapseSidebar = document.getElementById('collapseSidebar');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const search = document.getElementById('globalSearch');

  // Dark mode initialization and toggle
  const savedTheme = localStorage.getItem('desiarr-theme');
  if (savedTheme === 'dark') {
    html.classList.add('dark');
  } else if (savedTheme === 'light') {
    html.classList.remove('dark');
  } else {
    // Default to system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      html.classList.add('dark');
      localStorage.setItem('desiarr-theme', 'dark');
    } else {
      localStorage.setItem('desiarr-theme', 'light');
    }
  }

  toggle?.addEventListener('click', () => {
    html.classList.toggle('dark');
    const isDark = html.classList.contains('dark');
    localStorage.setItem('desiarr-theme', isDark ? 'dark' : 'light');
  });

  // Sidebar mobile controls
  openSidebar?.addEventListener('click', () => {
    sidebar?.classList.remove('-translate-x-full');
    sidebarOverlay?.classList.remove('hidden');
  });

  collapseSidebar?.addEventListener('click', () => {
    sidebar?.classList.add('-translate-x-full');
    sidebarOverlay?.classList.add('hidden');
  });

  // Close sidebar when clicking overlay
  sidebarOverlay?.addEventListener('click', () => {
    sidebar?.classList.add('-translate-x-full');
    sidebarOverlay?.classList.add('hidden');
  });

  // Close sidebar on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.innerWidth < 1024) {
      sidebar?.classList.add('-translate-x-full');
      sidebarOverlay?.classList.add('hidden');
    }
  });

  // Close sidebar on mobile when clicking navigation links
  document.querySelectorAll('#sidebar nav a').forEach(link => {
    link.addEventListener('click', () => {
      // Only close on mobile (screens < 1024px)
      if (window.innerWidth < 1024) {
        sidebar?.classList.add('-translate-x-full');
        sidebarOverlay?.classList.add('hidden');
      }
    });
  });

  // Global search keyboard shortcut (Cmd/Ctrl + K)
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      search?.focus();
      search?.select();
    }
  });

  // Connect global search based on current page
  if (search) {
    const path = window.location.pathname;

    // Generic handler: on any page, if dashboard filterMovies is defined, call it
    // This makes dashboard search work on /, /movies, /tv, /dashboard, etc.
    function genericDashboardFilterHandler() {
      if (typeof window.filterMovies === 'function') {
        try {
          window.filterMovies();
        } catch (error) {
          console.error('Error calling filterMovies:', error);
        }
      }
    }

    search.addEventListener('input', genericDashboardFilterHandler);
    search.addEventListener('keyup', genericDashboardFilterHandler);
    search.addEventListener('change', genericDashboardFilterHandler);

    // URL-based search pages
    if (path === '/data/releases' || path === '/data/tv-releases') {
      // All Releases & TV Releases pages - URL-based search with debouncing
      let searchTimeout = null;
      
      // Show/hide clear button based on search value
      function updateClearButton() {
        const clearBtn = document.getElementById('clearGlobalSearch');
        if (clearBtn) {
          if (search.value.trim()) {
            clearBtn.style.display = 'block';
          } else {
            clearBtn.style.display = 'none';
          }
        }
      }
      
      // Initial check for clear button
      updateClearButton();
      
      search.addEventListener('input', () => {
        updateClearButton();
        
        // Clear existing timeout
        if (searchTimeout) {
          clearTimeout(searchTimeout);
        }
        
        // Debounce search - update URL after 500ms of no typing
        searchTimeout = setTimeout(() => {
          const searchTerm = search.value.trim();
          const url = new URL(window.location.href);
          
          if (searchTerm) {
            url.searchParams.set('search', searchTerm);
          } else {
            url.searchParams.delete('search');
          }
          
          window.location.href = url.toString();
        }, 500);
      });
      
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          // Clear timeout and search immediately on Enter
          if (searchTimeout) {
            clearTimeout(searchTimeout);
          }
          
          const searchTerm = search.value.trim();
          const url = new URL(window.location.href);
          
          if (searchTerm) {
            url.searchParams.set('search', searchTerm);
          } else {
            url.searchParams.delete('search');
          }
          
          window.location.href = url.toString();
        }
      });

      // Clear button support (used by header)
      window.clearGlobalSearch = function() {
        search.value = '';
        updateClearButton();
        const url = new URL(window.location.href);
        url.searchParams.delete('search');
        window.location.href = url.toString();
      };
    }
    else if (path === '/data/radarr' || path === '/data/sonarr') {
    let searchTimeout = null;
    
    // Show/hide clear button based on search value
    function updateClearButton() {
      const clearBtn = document.getElementById('clearGlobalSearch');
      if (clearBtn) {
        if (search.value.trim()) {
          clearBtn.style.display = 'block';
        } else {
          clearBtn.style.display = 'none';
        }
      }
    }
    
    // Initial check for clear button
    updateClearButton();
    
    search.addEventListener('input', (e) => {
      updateClearButton();
      
      // Clear existing timeout
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }
      
      // Debounce the search (wait 500ms after user stops typing)
      searchTimeout = setTimeout(() => {
        const searchTerm = e.target.value.trim();
        const url = new URL(window.location.href);
        
        if (searchTerm) {
          url.searchParams.set('search', searchTerm);
          url.searchParams.set('page', '1'); // Reset to first page on search
        } else {
          url.searchParams.delete('search');
          url.searchParams.set('page', '1');
        }
        
        window.location.href = url.toString();
      }, 500);
    });

    // Handle Enter key for immediate search
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (searchTimeout) {
          clearTimeout(searchTimeout);
        }
        const searchTerm = e.target.value.trim();
        const url = new URL(window.location.href);
        
        if (searchTerm) {
          url.searchParams.set('search', searchTerm);
          url.searchParams.set('page', '1');
        } else {
          url.searchParams.delete('search');
          url.searchParams.set('page', '1');
        }
        
        window.location.href = url.toString();
      }
    });
    
    // Clear search function
    window.clearGlobalSearch = function() {
      search.value = '';
      updateClearButton();
      const url = new URL(window.location.href);
      url.searchParams.delete('search');
      url.searchParams.set('page', '1');
      window.location.href = url.toString();
    };
    }
    // RSS Data page - filter table client-side
    else if (path === '/data/rss') {
      // Wait for RSS page scripts to load
      function setupRssSearch() {
        if (typeof window.filterTable === 'function') {
          search.addEventListener('input', () => {
            window.filterTable();
          });
          search.addEventListener('keyup', () => {
            window.filterTable();
          });
          // Trigger initial filter if there's a search term
          if (search.value) {
            window.filterTable();
          }
        } else {
          setTimeout(setupRssSearch, 100);
        }
      }
      setupRssSearch();
    }
    // Logs page - instant client-side filtering via global search
    // The log-explorer.ejs handles its own global search for instant filtering
    // This is just for backward compatibility with old logs page
    else if (path === '/data/logs-old') {
      // Old logs page - keep URL-based filtering
      let searchTimeout = null;
      
      const urlParams = new URLSearchParams(window.location.search);
      const filterParam = urlParams.get('filter');
      if (filterParam && search) {
        search.value = filterParam;
      }
      
      search.addEventListener('input', (e) => {
        if (searchTimeout) {
          clearTimeout(searchTimeout);
        }
        
        searchTimeout = setTimeout(() => {
          const searchTerm = e.target.value.trim();
          const url = new URL(window.location.href);
          
          if (searchTerm) {
            url.searchParams.set('filter', searchTerm);
          } else {
            url.searchParams.delete('filter');
          }
          
          window.location.href = url.toString();
        }, 500);
      });

      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (searchTimeout) {
            clearTimeout(searchTimeout);
          }
          const searchTerm = e.target.value.trim();
          const url = new URL(window.location.href);
          
          if (searchTerm) {
            url.searchParams.set('filter', searchTerm);
          } else {
            url.searchParams.delete('filter');
          }
          
          window.location.href = url.toString();
        }
      });
      
      window.clearGlobalSearch = function() {
        if (search) {
          search.value = '';
        }
        const url = new URL(window.location.href);
        url.searchParams.delete('filter');
        window.location.href = url.toString();
      };
    }
    // /data/logs is handled by log-explorer.ejs setupGlobalSearch() for instant client-side filtering
    // Log explorer page - handled by page's own script for instant filtering
    else if (path.includes('/logs')) {
      // The log-explorer.ejs page handles its own global search
      // No need to do anything here - the page script will handle it
    }
    // Settings page - no search functionality needed
    else if (path === '/settings') {
      // No search functionality on settings page
      search.style.display = 'none';
    }
  }


  // Icon rendering system
  const iconSet = {
    'layout-dashboard': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
    'list': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
    'movie': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><path d="M7 4v16M17 4v16M2 8h20M2 12h20M2 16h20"></path></svg>',
    'tv': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>',
    'database': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>',
    'rss': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1"></circle></svg>',
    'file-text': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
    'settings': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
  };

  // Render all icons
  document.querySelectorAll('i[data-icon]').forEach(el => {
    const icon = el.getAttribute('data-icon');
    if (iconSet[icon]) {
      el.innerHTML = iconSet[icon];
      el.style.display = 'inline-block';
      el.style.width = '100%';
      el.style.height = '100%';
    }
  });

  // Handle window resize - show sidebar on desktop, hide on mobile
  function handleResize() {
    if (window.innerWidth >= 1024) {
      sidebar?.classList.remove('-translate-x-full');
      sidebarOverlay?.classList.add('hidden');
    } else {
      sidebar?.classList.add('-translate-x-full');
    }
  }

  window.addEventListener('resize', handleResize);
  handleResize(); // Initial check

  // Format last refresh/sync timestamps (works on all pages)
  function formatLastRefreshTime() {
    const lastRefreshElement = document.getElementById('lastRefreshTime');
    if (lastRefreshElement && lastRefreshElement.dataset.utc) {
      const utcDate = new Date(lastRefreshElement.dataset.utc);
      // Format in user's local timezone with timezone info
      const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      };
      lastRefreshElement.textContent = utcDate.toLocaleString(undefined, options);
    }
  }

  // Run on DOMContentLoaded and also immediately (in case DOM is already loaded)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', formatLastRefreshTime);
  } else {
    formatLastRefreshTime();
  }
})();

