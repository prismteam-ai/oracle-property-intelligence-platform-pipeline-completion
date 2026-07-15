(function () {
  const banner = document.getElementById("dataset-empty-banner");
  const button = document.getElementById("load-dataset-btn");
  const statusEl = document.getElementById("load-dataset-status");
  if (!banner || !button) return;

  let pollTimer = null;

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("load-error", Boolean(isError));
  }

  function setLoading(active) {
    button.disabled = active;
    button.textContent = active ? "Loading dataset…" : "Load dataset";
  }

  async function fetchStatus() {
    const res = await fetch("/api/dataset/status");
    return res.json();
  }

  async function pollUntilReady() {
    try {
      const data = await fetchStatus();
      if (data.ready) {
        setStatus("Dataset ready — refreshing page…", false);
        window.location.reload();
        return;
      }
      const pipeline = data.pipeline || {};
      if (pipeline.status === "failed") {
        setLoading(false);
        setStatus(pipeline.error || "Pipeline failed", true);
        return;
      }
      if (pipeline.status === "running") {
        setLoading(true);
        setStatus(
          "Ingesting Santa Clara records from IPFS, Socrata, and OpenStreetMap. This may take several minutes…",
          false
        );
        pollTimer = setTimeout(pollUntilReady, 3000);
        return;
      }
      setLoading(false);
    } catch (err) {
      setLoading(false);
      setStatus(err.message || "Could not check dataset status", true);
    }
  }

  button.addEventListener("click", async () => {
    setLoading(true);
    setStatus("Starting pipeline…", false);
    try {
      const res = await fetch("/api/pipeline/load", { method: "POST" });
      const data = await res.json();
      if (res.status === 409) {
        window.location.reload();
        return;
      }
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || "Could not start pipeline");
      }
      pollUntilReady();
    } catch (err) {
      setLoading(false);
      setStatus(err.message, true);
    }
  });

  fetchStatus().then((data) => {
    const pipeline = data.pipeline || {};
    if (pipeline.status === "running") {
      setLoading(true);
      pollUntilReady();
    }
  });
})();
