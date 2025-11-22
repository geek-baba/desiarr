// Simple in-memory log storage for displaying logs in UI (backward compatibility)
// Also writes to structured logs database
import type { LogSource } from './structuredLogging';

interface LogEntry {
  timestamp: Date;
  level: 'log' | 'error' | 'warn' | 'info';
  message: string;
}

const MAX_LOGS = 1000;
const logs: LogEntry[] = [];

// Override console methods to capture logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;

function addLog(level: LogEntry['level'], ...args: any[]) {
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');

  logs.push({
    timestamp: new Date(),
    level,
    message,
  });

  // Keep only the last MAX_LOGS entries
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }

  // Also write to structured logs database
  try {
    // Dynamic import to avoid circular dependencies
    import('./structuredLogging').then((module) => {
      const { logger } = module;
      const structuredLevel = level === 'error' ? 'ERROR' : 
                             level === 'warn' ? 'WARN' :
                             level === 'info' ? 'INFO' : 'DEBUG';
      
      // Try to infer source from message
      let source: LogSource = 'system';
      const msgLower = message.toLowerCase();
      if (msgLower.includes('radarr') || msgLower.includes('sync')) {
        source = msgLower.includes('rss') ? 'rss-sync' : 'radarr-sync';
      } else if (msgLower.includes('matching') || msgLower.includes('match')) {
        source = 'matching-engine';
      } else if (msgLower.includes('tmdb')) {
        source = 'tmdb';
      } else if (msgLower.includes('imdb')) {
        source = 'imdb';
      } else if (msgLower.includes('parse') || msgLower.includes('parser')) {
        source = 'parser';
      } else if (msgLower.includes('score') || msgLower.includes('scoring')) {
        source = 'scoring';
      } else if (msgLower.includes('dashboard')) {
        source = 'dashboard';
      } else if (msgLower.includes('api')) {
        source = 'api';
      }

      // Extract details if message contains structured data
      let details: any = undefined;
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'object' && lastArg !== null && !(lastArg instanceof Error)) {
        details = lastArg;
      }

      const options = {
        details,
        error: lastArg instanceof Error ? lastArg : undefined,
      };

      // Call the appropriate logger method based on level
      if (structuredLevel === 'ERROR') {
        logger.error(source, message, options);
      } else if (structuredLevel === 'WARN') {
        logger.warn(source, message, options);
      } else if (structuredLevel === 'INFO') {
        logger.info(source, message, options);
      } else {
        logger.debug(source, message, options);
      }
    }).catch(() => {
      // Silently fail - don't break console logging
    });
  } catch (error) {
    // Silently fail - don't break console logging
  }
}

console.log = (...args: any[]) => {
  addLog('log', ...args);
  originalConsoleLog(...args);
};

console.error = (...args: any[]) => {
  addLog('error', ...args);
  originalConsoleError(...args);
};

console.warn = (...args: any[]) => {
  addLog('warn', ...args);
  originalConsoleWarn(...args);
};

console.info = (...args: any[]) => {
  addLog('info', ...args);
  originalConsoleInfo(...args);
};

export const logStorage = {
  getLogs: (limit: number = 500): LogEntry[] => {
    return logs.slice(-limit).reverse(); // Most recent first
  },

  getLogsByFilter: (filter: string, limit: number = 500): LogEntry[] => {
    const lowerFilter = filter.toLowerCase();
    // Filter all logs, then take the last N (most recent), then reverse to show newest first
    const filtered = logs.filter(log => log.message.toLowerCase().includes(lowerFilter));
    return filtered.slice(-limit).reverse();
  },

  clear: (): void => {
    logs.length = 0;
  },

  getCount: (): number => {
    return logs.length;
  },
};

