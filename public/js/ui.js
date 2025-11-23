(function() {
  'use strict';

  const html = document.documentElement;
  const toggle = document.getElementById('darkModeToggle');
  const openSidebar = document.getElementById('openSidebar');
  const collapseSidebar = document.getElementById('collapseSidebar');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const search = document.getElementById('globalSearch');
  const refreshBtn = document.getElementById('refreshBtn');

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
    
    // Dashboard page - filter movies client-side
    if (path === '/' || path === '/dashboard') {
      // Use event delegation and direct function call
      function setupDashboardSearch() {
        const globalSearch = document.getElementById('globalSearch');
        if (!globalSearch) {
          setTimeout(setupDashboardSearch, 50);
          return;
        }
        
        // Remove any existing listeners by using a flag or one-time setup
        if (globalSearch.dataset.dashboardConnected === 'true') {
          return; // Already connected
        }
        
        // Mark as connected
        globalSearch.dataset.dashboardConnected = 'true';
        
        // Create a handler that calls filterMovies
        function triggerFilter() {
          // Wait for function to be available, then call it
          if (typeof window.filterMovies === 'function') {
            try {
              window.filterMovies();
            } catch (error) {
              console.error('Error calling filterMovies:', error);
            }
          } else {
            // Function not ready yet, try again after a short delay
            setTimeout(() => {
              if (typeof window.filterMovies === 'function') {
                try {
                  window.filterMovies();
                } catch (error) {
                  console.error('Error calling filterMovies (delayed):', error);
                }
              }
            }, 100);
          }
        }
        
        // Attach listeners
        globalSearch.addEventListener('input', triggerFilter);
        globalSearch.addEventListener('keyup', triggerFilter);
        globalSearch.addEventListener('change', triggerFilter);
      }
      
      // Try multiple times
      setupDashboardSearch();
      setTimeout(setupDashboardSearch, 100);
      setTimeout(setupDashboardSearch, 300);
      setTimeout(setupDashboardSearch, 500);
      setTimeout(setupDashboardSearch, 1000);
      
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupDashboardSearch);
      }
      window.addEventListener('load', setupDashboardSearch);
    }
    // Radarr Data page - URL-based search
    else if (path === '/data/radarr') {
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

  // Refresh button functionality
  refreshBtn?.addEventListener('click', () => {
    const path = window.location.pathname;
    
    // Show loading state
    const originalText = refreshBtn.textContent;
    refreshBtn.textContent = 'Refreshing...';
    refreshBtn.disabled = true;
    
    if (path === '/' || path === '/dashboard') {
      // Dashboard refresh - trigger matching engine
      fetch('/actions/refresh', { method: 'POST' })
        .then(() => {
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        })
        .catch(() => {
          refreshBtn.textContent = originalText;
          refreshBtn.disabled = false;
          alert('Refresh failed. Please try again.');
        });
    } else {
      // Other pages - just reload
      window.location.reload();
    }
  });

  // Icon rendering system
  const iconSet = {
    'layout-dashboard': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
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
})();

