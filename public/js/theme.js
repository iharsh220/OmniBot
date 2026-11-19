// Runs before first paint (classic script, no module) so there is no light/dark flash.
(function () {
  try {
    var t = localStorage.getItem('omnichat.theme') || 'system';
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow system */ }
})();
