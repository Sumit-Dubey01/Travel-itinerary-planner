const BASE = import.meta.env.VITE_API_URL || "";

// Anonymous per-browser id so each visitor sees only their own saved trips.
export function clientId() {
  let id = localStorage.getItem("wayfarer_client_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("wayfarer_client_id", id);
  }
  return id;
}

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Client-Id": clientId(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {}
    throw new Error(detail || "Request failed");
  }
  return res.json();
}

export const api = {
  health: () => call("/api/health"),
  generate: (request) => call("/api/itinerary/generate", { method: "POST", body: JSON.stringify(request) }),
  regenerateDay: (request, itinerary, day) =>
    call("/api/itinerary/regenerate-day", { method: "POST", body: JSON.stringify({ request, itinerary, day }) }),
  listTrips: () => call("/api/trips"),
  saveTrip: (payload) => call("/api/trips", { method: "POST", body: JSON.stringify(payload) }),
  updateTrip: (id, payload) => call(`/api/trips/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteTrip: (id) => call(`/api/trips/${id}`, { method: "DELETE" }),
};
