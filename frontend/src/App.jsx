import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

const INTERESTS = ["Food", "Sightseeing", "History", "Nature", "Nightlife", "Shopping", "Art", "Adventure"];
const STYLES = [
  ["relaxed", "Relaxed", "Fewer stops, longer breaks"],
  ["balanced", "Balanced", "A mix of must-sees and downtime"],
  ["adventurous", "Adventurous", "Early starts, full days"],
  ["luxury", "Premium", "Upscale stays and dining"],
];
const TYPE_LABEL = { attraction: "Sight", food: "Food", stay: "Stay", transport: "Travel", activity: "Activity" };

const money = (n, cur) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n || 0);

export default function App() {
  const [view, setView] = useState("plan"); // plan | trip | saved
  const [form, setForm] = useState({
    destination: "",
    days: 3,
    budget: 900,
    currency: "USD",
    travelers: 1,
    style: "balanced",
    interests: ["Food", "Sightseeing"],
    start_date: "",
    notes: "",
  });
  const [trip, setTrip] = useState(null); // { id?, request, itinerary, image_url }
  const [saved, setSaved] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.health().then(setStatus).catch(() => setStatus({ status: "down" }));
  }, []);

  const flash = (m) => {
    setToast(m);
    setTimeout(() => setToast(""), 2200);
  };

  const loadSaved = async () => {
    try {
      setSaved(await api.listTrips());
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    if (view === "saved") loadSaved();
  }, [view]);

  const generate = async (e) => {
    e.preventDefault();
    setError("");
    setBusy("generate");
    try {
      const request = { ...form, interests: form.interests.map((i) => i.toLowerCase()), start_date: form.start_date || null, notes: form.notes || null };
      const res = await api.generate(request);
      setTrip({ request, itinerary: res.itinerary, image_url: res.image_url, source: res.source });
      setView("trip");
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const regenerateDay = async (day) => {
    setBusy("day" + day);
    try {
      const res = await api.regenerateDay(trip.request, trip.itinerary, day);
      setTrip({ ...trip, itinerary: res.itinerary });
      flash(`Day ${day} regenerated`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const saveTrip = async () => {
    setBusy("save");
    try {
      const payload = { request: trip.request, itinerary: trip.itinerary, image_url: trip.image_url };
      const row = trip.id ? await api.updateTrip(trip.id, payload) : await api.saveTrip(payload);
      setTrip({ ...trip, id: row.id });
      flash("Trip saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const removeSaved = async (id) => {
    await api.deleteTrip(id);
    setSaved(saved.filter((t) => t.id !== id));
    if (trip?.id === id) setTrip({ ...trip, id: undefined });
    flash("Trip deleted");
  };

  const editItinerary = (fn) => {
    const it = structuredClone(trip.itinerary);
    fn(it);
    setTrip({ ...trip, itinerary: it });
  };

  const openSaved = (t) => {
    setTrip({ id: t.id, request: t.request, itinerary: t.itinerary, image_url: t.image_url });
    setView("trip");
    window.scrollTo(0, 0);
  };

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => setView("plan")}>Wayfarer</button>
        <nav>
          <button className={view === "plan" ? "on" : ""} onClick={() => setView("plan")}>Plan a trip</button>
          {trip && <button className={view === "trip" ? "on" : ""} onClick={() => setView("trip")}>Current trip</button>}
          <button className={view === "saved" ? "on" : ""} onClick={() => setView("saved")}>Saved trips</button>
        </nav>
      </header>

      {status?.status === "down" && (
        <div className="banner err">Can't reach the API. Start the backend with <code>uvicorn main:app --reload</code> in the backend folder.</div>
      )}
      {error && (
        <div className="banner err" role="alert">
          {error} <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      <main>
        {view === "plan" && <Planner form={form} setForm={setForm} onSubmit={generate} busy={busy === "generate"} status={status} />}
        {view === "trip" && trip && (
          <Trip
            trip={trip}
            busy={busy}
            onRegenerate={regenerateDay}
            onSave={saveTrip}
            edit={editItinerary}
            onTitle={(title) => editItinerary((it) => { it.title = title; })}
          />
        )}
        {view === "saved" && <Saved trips={saved} onOpen={openSaved} onDelete={removeSaved} onNew={() => setView("plan")} />}
      </main>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Planner({ form, setForm, onSubmit, busy, status }) {
  const set = (k, v) => setForm({ ...form, [k]: v });
  const toggle = (i) =>
    set("interests", form.interests.includes(i) ? form.interests.filter((x) => x !== i) : [...form.interests, i]);
  const perPerson = form.travelers ? Math.round(form.budget / form.travelers) : 0;

  return (
    <div className="planner">
      <section className="intro">
        <h1>Where to next?</h1>
        <p>Tell us the basics. We build a day-by-day plan you can edit, reshuffle, and save.</p>
        {status && status.status === "ok" && (
          <p className="engine">
            Planner engine: <b>{status.ai === "groq" ? "Groq AI" : "Offline starter plans"}</b>. Storage: <b>{status.storage === "supabase" ? "Supabase" : "Local file"}</b>.
          </p>
        )}
      </section>

      <form className="card form" onSubmit={onSubmit}>
        <label className="wide">
          Destination
          <input required minLength={2} placeholder="Lisbon, Portugal" value={form.destination} onChange={(e) => set("destination", e.target.value)} />
        </label>

        <label>
          Days
          <input type="number" min="1" max="14" value={form.days} onChange={(e) => set("days", +e.target.value)} />
        </label>
        <label>
          Travelers
          <input type="number" min="1" max="20" value={form.travelers} onChange={(e) => set("travelers", +e.target.value)} />
        </label>
        <label>
          Total budget
          <div className="inline">
            <input type="number" min="0" step="50" value={form.budget} onChange={(e) => set("budget", +e.target.value)} />
            <select value={form.currency} onChange={(e) => set("currency", e.target.value)} aria-label="Currency">
              {["USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <small>About {money(perPerson, form.currency)} per person</small>
        </label>
        <label>
          Start date (optional)
          <input type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
        </label>

        <fieldset className="wide">
          <legend>Travel style</legend>
          <div className="styles">
            {STYLES.map(([v, name, hint]) => (
              <label key={v} className={"style" + (form.style === v ? " on" : "")}>
                <input type="radio" name="style" checked={form.style === v} onChange={() => set("style", v)} />
                <b>{name}</b>
                <span>{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="wide">
          <legend>Interests</legend>
          <div className="chips">
            {INTERESTS.map((i) => (
              <button type="button" key={i} className={"chip" + (form.interests.includes(i) ? " on" : "")} aria-pressed={form.interests.includes(i)} onClick={() => toggle(i)}>
                {i}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="wide">
          Anything else? (optional)
          <textarea rows="2" placeholder="Vegetarian, travelling with a toddler, avoid long walks…" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>

        <button className="primary wide" disabled={busy}>{busy ? "Building your itinerary…" : "Generate itinerary"}</button>
      </form>
    </div>
  );
}

function Trip({ trip, busy, onRegenerate, onSave, edit, onTitle }) {
  const { itinerary: it, request: req } = trip;
  const cur = req.currency;
  const total = useMemo(() => it.days.reduce((s, d) => s + d.items.reduce((a, b) => a + (+b.cost || 0), 0), 0), [it]);
  const pct = req.budget ? Math.min(100, (total / req.budget) * 100) : 0;
  const over = total > req.budget;

  return (
    <div className="trip">
      <section className="hero" style={trip.image_url ? { backgroundImage: `linear-gradient(180deg, rgba(16,38,59,.25), rgba(16,38,59,.85)), url(${trip.image_url})` } : undefined}>
        <input className="title-input" aria-label="Trip title" value={it.title} onChange={(e) => onTitle(e.target.value)} />
        <p>{it.summary}</p>
        <div className="meter" aria-label="Budget used">
          <div className="meter-head">
            <span>Estimated spend <b>{money(total, cur)}</b> of {money(req.budget, cur)}</span>
            <span className={over ? "warn" : ""}>{over ? `${money(total - req.budget, cur)} over budget` : `${money(req.budget - total, cur)} left`}</span>
          </div>
          <div className="bar"><i style={{ width: pct + "%" }} className={over ? "over" : ""} /></div>
        </div>
        <div className="hero-actions">
          <button className="primary" onClick={onSave} disabled={busy === "save"}>{busy === "save" ? "Saving…" : trip.id ? "Update saved trip" : "Save trip"}</button>
          <button className="ghost" onClick={() => window.print()}>Print</button>
        </div>
      </section>

      {it.days.map((d) => {
        const dayTotal = d.items.reduce((a, b) => a + (+b.cost || 0), 0);
        return (
          <section className="day card" key={d.day}>
            <div className="day-head">
              <div>
                <h2>Day {d.day}: {d.theme}</h2>
                <small>{money(dayTotal, cur)} planned</small>
              </div>
              <div className="day-actions">
                <button className="ghost" disabled={busy === "day" + d.day} onClick={() => onRegenerate(d.day)}>
                  {busy === "day" + d.day ? "Regenerating…" : "Regenerate day"}
                </button>
              </div>
            </div>
            <ol className="items">
              {d.items.map((item, idx) => (
                <li key={item.id || idx} className={"item " + item.type}>
                  <input className="time" type="time" value={item.time} aria-label="Time" onChange={(e) => edit((x) => { x.days[d.day - 1].items[idx].time = e.target.value; })} />
                  <div className="body">
                    <span className="tag">{TYPE_LABEL[item.type] || "Activity"}</span>
                    <input className="item-title" value={item.title} aria-label="Activity" onChange={(e) => edit((x) => { x.days[d.day - 1].items[idx].title = e.target.value; })} />
                    <p>{item.description}</p>
                  </div>
                  <div className="cost">
                    <input type="number" min="0" value={Math.round(item.cost)} aria-label="Cost" onChange={(e) => edit((x) => { x.days[d.day - 1].items[idx].cost = +e.target.value; })} />
                    <small>{cur}</small>
                  </div>
                  <button className="x" aria-label="Remove activity" onClick={() => edit((x) => { x.days[d.day - 1].items.splice(idx, 1); })}>×</button>
                </li>
              ))}
            </ol>
            <button className="add" onClick={() => edit((x) => { x.days[d.day - 1].items.push({ id: Math.random().toString(36).slice(2, 8), time: "12:00", title: "New activity", type: "activity", description: "", cost: 0 }); })}>
              Add an activity
            </button>
          </section>
        );
      })}

      {it.tips?.length > 0 && (
        <section className="card tips">
          <h2>Before you go</h2>
          <ul>{it.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function Saved({ trips, onOpen, onDelete, onNew }) {
  if (!trips.length)
    return (
      <div className="empty card">
        <h2>No saved trips yet</h2>
        <p>Generate an itinerary and choose Save trip to keep it here.</p>
        <button className="primary" onClick={onNew}>Plan a trip</button>
      </div>
    );
  return (
    <div className="saved">
      {trips.map((t) => (
        <article className="card trip-card" key={t.id}>
          <div className="thumb" style={t.image_url ? { backgroundImage: `url(${t.image_url})` } : undefined}>{!t.image_url && t.destination[0]}</div>
          <div>
            <h3>{t.title || t.destination}</h3>
            <small>{t.request.days} days, {t.request.travelers} traveler(s), {money(t.request.budget, t.request.currency)}</small>
          </div>
          <div className="row">
            <button className="primary" onClick={() => onOpen(t)}>Open</button>
            <button className="ghost" onClick={() => onDelete(t.id)}>Delete</button>
          </div>
        </article>
      ))}
    </div>
  );
}
