/* Extends the existing "Full Mock Tests" list on student-dashboard.html to 50 SSC CGL mocks.
   It copies your own Mock card, so the new cards look exactly like the ones you already have.
   Add this before </body>:  <script src="dashboard-mocks-patch.js"></script> */
(function () {
  var CFG = {
    exam: "cgl",
    total: 50,
    live: 1,                    // how many papers exist in /mocks (cgl-01.json ... ). Raise this as you add papers.
    player: "mock-player.html"
  };

  function findCard(n) {
    var tag = "Full Mock " + String(n).padStart(2, "0");
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), t;
    while ((t = w.nextNode())) {
      if (t.nodeValue.indexOf(tag) !== -1 && /CGL/.test(t.nodeValue) && t.parentElement.closest("[data-pp-new]") === null) {
        var el = t.parentElement;
        var other = "Full Mock " + String(n === 1 ? 2 : 1).padStart(2, "0");
        while (el.parentElement && el.parentElement !== document.body &&
               el.parentElement.textContent.indexOf(other) === -1) el = el.parentElement;
        return el;
      }
    }
    return null;
  }

  function setLink(card, n, isLive) {
    var url = CFG.player + "?exam=" + CFG.exam + "&id=" + n;
    var btns = card.querySelectorAll("a,button");
    btns.forEach(function (b) {
      if (!/start/i.test(b.textContent) && !/soon/i.test(b.textContent)) return;
      b.textContent = isLive ? "Start ↗" : "Coming soon";
      if (b.tagName === "A") { b.href = isLive ? url : "#"; b.removeAttribute("target"); }
      b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); if (isLive) location.href = url; };
      b.style.opacity = isLive ? "" : ".5";
    });
  }

  function setStatus(card, n) {
    var r = null;
    try { r = JSON.parse(localStorage.getItem("pp_mock_" + CFG.exam + "_" + n)); } catch (e) {}
    if (!r) return;
    card.querySelectorAll("*").forEach(function (el) {
      if (el.children.length === 0 && /Not attempted/i.test(el.textContent)) el.textContent = "Attempted · " + r.date;
      if (el.children.length === 0 && el.textContent.trim() === "—") el.textContent = r.score + "/" + r.max;
    });
  }

  function patch() {
    var first = findCard(1), tpl = findCard(2) || first;
    if (!first || first.dataset.ppDone) return;
    var last = first;
    for (var k = 2; k <= 4; k++) { var c = findCard(k); if (c) last = c; }
    var parent = first.parentElement;
    // Existing cards 01-04: point them at the new player.
    for (var i = 1; i <= 4; i++) {
      var c0 = findCard(i);
      if (c0) { setLink(c0, i, i <= CFG.live); setStatus(c0, i); c0.dataset.ppDone = "1"; }
    }
    // New cards 05-50: clone Mock 02 so the style matches.
    var ref = last;
    for (var n = 5; n <= CFG.total; n++) {
      var num = String(n).padStart(2, "0"), clone = tpl.cloneNode(true);
      clone.dataset.ppNew = "1"; clone.dataset.ppDone = "1";
      var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT), t;
      while ((t = w.nextNode())) t.nodeValue = t.nodeValue.replace(/Full Mock 0?2/, "Full Mock " + num);
      setLink(clone, n, n <= CFG.live);
      setStatus(clone, n);
      ref.parentElement.insertBefore(clone, ref.nextSibling);
      ref = clone;
    }
    // Sidebar badge (the "4" next to Full Mock Tests).
    document.querySelectorAll("*").forEach(function (el) {
      if (el.children.length === 0 && el.textContent.trim() === "4" && el.parentElement &&
          /Full Mock Tests/.test(el.parentElement.textContent)) el.textContent = String(CFG.total);
    });
  }

  var timer;
  new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(patch, 150); })
    .observe(document.body, { childList: true, subtree: true });
  window.addEventListener("load", patch);
})();
