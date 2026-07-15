const PROJECT_NAME = "Chief of Staff — Communications";

type AsanaProject = { gid: string; name?: string };

export async function createTaskFromMessage(input: {
  pat: string;
  title: string;
  notes: string;
  dueOn?: string;
}): Promise<{ gid: string; url: string }> {
  if (input.pat === "demo" || !input.pat) {
    const gid = `demo-task-${Date.now()}`;
    return { gid, url: `https://app.asana.com/0/0/${gid}` };
  }

  const me = await asanaFetch<{ workspaces?: { gid: string }[] }>("users/me", input.pat);
  const workspaceGid = me.workspaces?.[0]?.gid;
  if (!workspaceGid) throw new Error("No Asana workspace");

  const projectList = await asanaFetch<AsanaProject[]>(
    `projects?workspace=${workspaceGid}&archived=false&opt_fields=name`,
    input.pat,
  );
  let project = projectList.find((p) => p.name === PROJECT_NAME);
  if (!project) {
    project = await asanaPost<AsanaProject>("projects", input.pat, {
      data: { name: PROJECT_NAME, workspace: workspaceGid },
    });
  }

  const task = await asanaPost<{ gid: string }>("tasks", input.pat, {
    data: {
      name: input.title,
      notes: input.notes,
      projects: [project.gid],
      due_on: input.dueOn,
    },
  });
  return { gid: task.gid, url: `https://app.asana.com/0/${project.gid}/${task.gid}` };
}

async function asanaFetch<T>(path: string, pat: string): Promise<T> {
  const res = await fetch(`https://app.asana.com/api/1.0/${path}`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) throw new Error(`Asana API ${res.status}`);
  const json = (await res.json()) as { data: T };
  return json.data;
}

async function asanaPost<T>(path: string, pat: string, body: unknown): Promise<T> {
  const res = await fetch(`https://app.asana.com/api/1.0/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Asana API ${res.status}`);
  const json = (await res.json()) as { data: T };
  return json.data;
}
