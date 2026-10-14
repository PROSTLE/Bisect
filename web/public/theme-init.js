// Apply the saved theme before first paint (light is the default).
try {
  var t = localStorage.getItem('bisect.theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
