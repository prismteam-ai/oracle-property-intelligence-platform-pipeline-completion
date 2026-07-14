function sidebar(active) {
  document.body.insertAdjacentHTML("afterbegin", `
  <div class="sidebar">
    <div class="logo">Oracle<br><span>Property Intel</span></div>
    <nav>
      <a href="/pipeline" class="${active==='pipeline'?'active':''}">Pipeline</a>
      <a href="/chat" class="${active==='chat'?'active':''}">Chat</a>
      <a href="/data" class="${active==='data'?'active':''}">Data Exploration</a>
    </nav>
  </div>`);
}
const fmt = n => (n||0).toLocaleString();
const esc = v => v === null || v === undefined ? "<span style='color:var(--dim)'>∅</span>"
  : String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;");
