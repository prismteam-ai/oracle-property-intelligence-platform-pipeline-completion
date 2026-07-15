(function () {
  const PRESET_FROM_SLUG = {
    roofs: "roofs",
    water: "water",
    ownership: "ownership",
    regional: "regional",
    transit: "transit",
    starbucks: "starbucks",
    "roofs-older-than-15-years": "roofs",
    "view-of-water": "water",
    "not-exchanged-ownership-in-more-than-10-years": "ownership",
    "regional-owners": "regional",
    "walking-distance-of-public-transportation": "transit",
    "walking-distance-of-starbucks": "starbucks",
  };

  const form = document.getElementById("sandbox-form");
  const sqlForm = document.getElementById("sql-form");
  const resultTitle = document.getElementById("result-title");
  const resultBasis = document.getElementById("result-basis");
  const resultMeta = document.getElementById("result-meta");
  const resultTable = document.getElementById("result-table");
  const runButton = form.querySelector('button[type="submit"]');
  let debounceTimer = null;
  let requestSeq = 0;

  function bindRange(id) {
    const input = document.getElementById(id);
    const label = document.getElementById(id + "_val");
    if (!input || !label) return;
    const sync = () => { label.textContent = input.value; };
    input.addEventListener("input", sync);
    sync();
  }
  ["min_roof_age", "min_ownership_years", "max_transit_m", "max_starbucks_m", "max_water_m"].forEach(bindRange);

  function resolvePresetFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("preset");
    if (fromQuery && PRESET_FROM_SLUG[fromQuery]) {
      return PRESET_FROM_SLUG[fromQuery];
    }
    const hash = window.location.hash.replace(/^#/, "");
    if (hash && PRESET_FROM_SLUG[hash]) {
      return PRESET_FROM_SLUG[hash];
    }
    return null;
  }

  function applyPresetFromUrl() {
    const preset = resolvePresetFromUrl();
    if (!preset) return;
    const select = document.getElementById("preset");
    if (select && select.querySelector(`option[value="${preset}"]`)) {
      select.value = preset;
      toggleFields();
    }
  }

  function toggleFields() {
    const preset = document.getElementById("preset").value;
    document.querySelectorAll(".field-roof").forEach((el) => {
      el.style.display = preset === "roofs" ? "" : "none";
    });
    document.querySelectorAll(".field-ownership").forEach((el) => {
      el.style.display = preset === "ownership" ? "" : "none";
    });
    document.querySelectorAll(".field-transit").forEach((el) => {
      el.style.display = preset === "transit" ? "" : "none";
    });
    document.querySelectorAll(".field-starbucks").forEach((el) => {
      el.style.display = preset === "starbucks" ? "" : "none";
    });
    document.querySelectorAll(".field-water").forEach((el) => {
      el.style.display = preset === "water" ? "" : "none";
    });
    document.querySelectorAll(".field-regional").forEach((el) => {
      el.style.display = preset === "regional" ? "" : "none";
    });
  }

  document.getElementById("preset").addEventListener("change", () => {
    toggleFields();
    schedulePresetQuery();
  });
  toggleFields();

  document.querySelectorAll(".sandbox-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".sandbox-tabs .tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const name = tab.dataset.tab;
      document.getElementById("panel-preset").classList.toggle("hidden", name !== "preset");
      document.getElementById("panel-sql").classList.toggle("hidden", name !== "sql");
    });
  });

  function renderTable(columns, rows) {
    if (!rows.length) {
      resultTable.innerHTML = '<p class="empty">No matching rows.</p>';
      return;
    }
    let html = "<table><thead><tr>";
    columns.forEach((c) => { html += `<th>${c}</th>`; });
    html += "</tr></thead><tbody>";
    rows.forEach((row) => {
      html += "<tr>";
      row.forEach((v) => { html += `<td>${v ?? ""}</td>`; });
      html += "</tr>";
    });
    html += "</tbody></table>";
    resultTable.innerHTML = html;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Query failed");
    return data;
  }

  function setLoading(active) {
    if (runButton) {
      runButton.disabled = active;
      runButton.textContent = active ? "Running…" : "Run query";
    }
    if (active) {
      resultMeta.textContent = "Running query…";
    }
  }

  async function runPresetQuery() {
    const seq = ++requestSeq;
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    setLoading(true);
    try {
      const data = await postJson("/api/sandbox/query", payload);
      if (seq !== requestSeq) return;
      resultTitle.textContent = data.question || "Results";
      resultBasis.textContent = data.basis || "";
      resultMeta.textContent = `${data.count} total matches · showing ${data.rows.length}`;
      renderTable(data.columns, data.rows);
    } catch (err) {
      if (seq !== requestSeq) return;
      resultMeta.textContent = err.message;
      resultTable.innerHTML = "";
    } finally {
      if (seq === requestSeq) setLoading(false);
    }
  }

  function schedulePresetQuery() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runPresetQuery, 350);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearTimeout(debounceTimer);
    await runPresetQuery();
  });

  form.querySelectorAll("input, select").forEach((el) => {
    if (el.id === "preset") return;
    el.addEventListener("input", schedulePresetQuery);
    el.addEventListener("change", schedulePresetQuery);
  });

  sqlForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sql = document.getElementById("sql").value;
    setLoading(true);
    try {
      const data = await postJson("/api/sandbox/sql", { sql });
      resultTitle.textContent = "SQL results";
      resultBasis.textContent = "";
      resultMeta.textContent = `${data.rows.length} rows`;
      renderTable(data.columns, data.rows);
    } catch (err) {
      resultMeta.textContent = err.message;
      resultTable.innerHTML = "";
    } finally {
      setLoading(false);
    }
  });

  applyPresetFromUrl();
  if (window.SANDBOX_DATASET_READY) {
    runPresetQuery();
  }
})();
