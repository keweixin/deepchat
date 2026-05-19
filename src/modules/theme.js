/**
 * Theme Module
 */

export function initTheme() {
  const saved = localStorage.getItem('dc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  
  // Update mermaid theme when loaded
  updateMermaidTheme(saved);
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('dc_theme', next);
  updateMermaidTheme(next);
  return next;
}

function updateMermaidTheme(theme) {
  if (window.mermaid) {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default'
      });
    } catch (_) {}
  }
}
