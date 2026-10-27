"""Personalized Travel Itinerary Planner - FastAPI backend.

Integrations (all optional, with graceful fallbacks):
  * Groq AI      -> generative itineraries
  * Unsplash API -> destination images
  * Supabase     -> persistent trip storage (PostgREST over httpx)
"""
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
UNSPLASH_KEY = os.getenv("UNSPLASH_ACCESS_KEY", "").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "").strip()
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

app = FastAPI(title="Travel Itinerary Planner API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in FRONTEND_ORIGIN.split(",")] + ["http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- models ----------
class TripRequest(BaseModel):
    destination: str = Field(min_length=2, max_length=120)
    days: int = Field(default=3, ge=1, le=14)
    budget: float = Field(default=800, ge=0)
    currency: str = "USD"
    travelers: int = Field(default=1, ge=1, le=20)
    style: str = "balanced"  # relaxed | balanced | adventurous | luxury
    interests: List[str] = []
    start_date: Optional[str] = None
    notes: Optional[str] = None


class TripSave(BaseModel):
    request: TripRequest
    itinerary: dict
    image_url: Optional[str] = None


class RegenerateDay(BaseModel):
    request: TripRequest
    itinerary: dict
    day: int


# ---------- storage (Supabase or local JSON) ----------
DATA_FILE = Path(__file__).parent / "data" / "trips.json"


def db_enabled() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY)


def _sb_headers():
    h = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if SUPABASE_KEY.startswith("eyJ"):  # legacy JWT keys also go in Authorization
        h["Authorization"] = f"Bearer {SUPABASE_KEY}"
    return h


def _local_load() -> list:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text() or "[]")
    return []


def _local_save(rows: list):
    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(rows, indent=2))


async def store_list(client_id: str) -> list:
    if db_enabled():
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(
                f"{SUPABASE_URL}/rest/v1/trips",
                params={"client_id": f"eq.{client_id}", "order": "created_at.desc"},
                headers=_sb_headers(),
            )
            r.raise_for_status()
            return r.json()
    return sorted(
        [t for t in _local_load() if t["client_id"] == client_id],
        key=lambda t: t["created_at"],
        reverse=True,
    )


async def store_create(row: dict) -> dict:
    if db_enabled():
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(f"{SUPABASE_URL}/rest/v1/trips", json=row, headers=_sb_headers())
            r.raise_for_status()
            return r.json()[0]
    rows = _local_load()
    rows.append(row)
    _local_save(rows)
    return row


async def store_update(trip_id: str, client_id: str, patch: dict) -> dict:
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    if db_enabled():
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.patch(
                f"{SUPABASE_URL}/rest/v1/trips",
                params={"id": f"eq.{trip_id}", "client_id": f"eq.{client_id}"},
                json=patch,
                headers=_sb_headers(),
            )
            r.raise_for_status()
            data = r.json()
            if not data:
                raise HTTPException(404, "Trip not found")
            return data[0]
    rows = _local_load()
    for row in rows:
        if row["id"] == trip_id and row["client_id"] == client_id:
            row.update(patch)
            _local_save(rows)
            return row
    raise HTTPException(404, "Trip not found")


async def store_delete(trip_id: str, client_id: str):
    if db_enabled():
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.delete(
                f"{SUPABASE_URL}/rest/v1/trips",
                params={"id": f"eq.{trip_id}", "client_id": f"eq.{client_id}"},
                headers=_sb_headers(),
            )
            r.raise_for_status()
        return
    rows = [r for r in _local_load() if not (r["id"] == trip_id and r["client_id"] == client_id)]
    _local_save(rows)


# ---------- AI ----------
SYSTEM_PROMPT = (
    "You are an expert travel planner. Reply with ONLY valid JSON, no markdown. "
    "Schema: {\"title\": str, \"summary\": str, \"days\": [{\"day\": int, \"theme\": str, "
    "\"items\": [{\"time\": \"HH:MM\", \"title\": str, \"type\": "
    "\"attraction|food|stay|transport|activity\", \"description\": str, \"cost\": number}]}], "
    "\"tips\": [str]}. Costs are for the whole group, in the requested currency. "
    "Group activities geographically to minimise travel time and respect the budget."
)


def _request_brief(req: TripRequest) -> str:
    return (
        f"Destination: {req.destination}\nDays: {req.days}\nTravelers: {req.travelers}\n"
        f"Total budget: {req.budget} {req.currency}\nTravel style: {req.style}\n"
        f"Interests: {', '.join(req.interests) or 'general sightseeing'}\n"
        f"Start date: {req.start_date or 'flexible'}\nNotes: {req.notes or 'none'}"
    )


async def call_groq(user_prompt: str) -> dict:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            json={
                "model": GROQ_MODEL,
                "temperature": 0.7,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
            },
        )
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    return json.loads(text)


def normalize(it: dict) -> dict:
    """Make sure the itinerary has the shape the UI expects."""
    it.setdefault("title", "Your trip")
    it.setdefault("summary", "")
    it.setdefault("tips", [])
    days = it.get("days") or []
    for i, d in enumerate(days, 1):
        d["day"] = i
        d.setdefault("theme", f"Day {i}")
        items = d.get("items") or []
        for item in items:
            item.setdefault("time", "09:00")
            item.setdefault("type", "activity")
            item.setdefault("description", "")
            try:
                item["cost"] = float(item.get("cost") or 0)
            except (TypeError, ValueError):
                item["cost"] = 0.0
            item["id"] = uuid.uuid4().hex[:8]
        d["items"] = items
    it["days"] = days
    return it


def offline_itinerary(req: TripRequest) -> dict:
    """Deterministic fallback used when no Groq key is configured."""
    dest = req.destination.title()
    interests = req.interests or ["sightseeing"]
    per_day = req.budget / max(req.days, 1)
    mult = {"relaxed": 0.9, "balanced": 1.0, "adventurous": 1.05, "luxury": 1.3}.get(req.style, 1.0)
    base = per_day * mult

    def mk(day: int) -> dict:
        focus = interests[(day - 1) % len(interests)]
        slow = req.style == "relaxed"
        items = [
            ("09:00", f"Breakfast at a local café in {dest}", "food", "Start slow with regional specialties.", 0.08),
            ("10:30" if slow else "10:00", f"{focus.title()} highlight of {dest}", "attraction",
             f"Top-rated {focus} stop. Arrive early to beat the crowds.", 0.22),
            ("13:00", "Lunch at a well-reviewed local spot", "food", "Look for set-menu lunch deals.", 0.15),
            ("15:00", f"Explore a {dest} neighbourhood on foot", "activity",
             "Short walking loop; keeps transport time low.", 0.10),
            ("19:30", "Dinner and evening stroll", "food", "Book ahead on weekends.", 0.25),
            ("21:30", "Local transport back to your stay", "transport", "Use public transit or a shared ride.", 0.05),
        ]
        if day == 1:
            items.insert(0, ("08:00", "Arrival and check-in", "stay", "Drop bags and pick up a transit pass.", 0.15))
        return {
            "day": day,
            "theme": f"{focus.title()} day",
            "items": [
                {"time": t, "title": ti, "type": ty, "description": de, "cost": round(base * share, 2)}
                for t, ti, ty, de, share in items
            ],
        }

    return {
        "title": f"{req.days} days in {dest}",
        "summary": (f"{'An' if req.style[0] in 'aeiou' else 'A'} {req.style} {req.days}-day plan for {req.travelers} traveler(s) in {dest}, "
                    f"focused on {', '.join(interests)}. This is an offline starter plan; add a "
                    f"GROQ_API_KEY to get AI-generated trips."),
        "days": [mk(d) for d in range(1, req.days + 1)],
        "tips": ["Book popular attractions in advance.", "Carry a reusable water bottle.",
                 "Keep 10% of your budget as a buffer."],
    }


async def unsplash_image(query: str) -> Optional[str]:
    if not UNSPLASH_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                "https://api.unsplash.com/search/photos",
                params={"query": f"{query} travel", "per_page": 1, "orientation": "landscape"},
                headers={"Authorization": f"Client-ID {UNSPLASH_KEY}"},
            )
            r.raise_for_status()
            results = r.json().get("results", [])
            return results[0]["urls"]["regular"] if results else None
    except Exception:
        return None


# ---------- routes ----------
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "ai": "groq" if GROQ_API_KEY else "offline-fallback",
        "storage": "supabase" if db_enabled() else "local-json",
        "images": "unsplash" if UNSPLASH_KEY else "none",
    }


@app.post("/api/itinerary/generate")
async def generate(req: TripRequest):
    source = "offline"
    if GROQ_API_KEY:
        try:
            itinerary = await call_groq("Plan this trip:\n" + _request_brief(req))
            source = "groq"
        except Exception as e:  # network, quota, bad JSON...
            print("Groq failed, using fallback:", e)
            itinerary = offline_itinerary(req)
    else:
        itinerary = offline_itinerary(req)
    return {
        "itinerary": normalize(itinerary),
        "image_url": await unsplash_image(req.destination),
        "source": source,
    }


@app.post("/api/itinerary/regenerate-day")
async def regenerate_day(body: RegenerateDay):
    req, it = body.request, body.itinerary
    if not 1 <= body.day <= len(it.get("days", [])):
        raise HTTPException(400, "Invalid day")
    new_day = None
    if GROQ_API_KEY:
        try:
            themes = [d.get("theme") for d in it["days"]]
            prompt = (
                "Plan this trip:\n" + _request_brief(req)
                + f"\n\nExisting day themes: {themes}. Regenerate ONLY day {body.day} with fresh "
                  "activities that don't repeat other days. Return the full schema with "
                  "exactly one entry in \"days\"."
            )
            res = await call_groq(prompt)
            new_day = (res.get("days") or [None])[0]
        except Exception as e:
            print("Groq regenerate failed:", e)
    if not new_day:
        ints = req.interests or ["sightseeing"]
        k = body.day % len(ints)
        rotated = req.model_copy(update={"interests": ints[k:] + ints[:k], "days": len(it["days"])})
        new_day = offline_itinerary(rotated)["days"][body.day - 1]
    it["days"][body.day - 1] = new_day
    return {"itinerary": normalize(it)}


@app.get("/api/trips")
async def list_trips(x_client_id: str = Header(...)):
    return await store_list(x_client_id)


@app.post("/api/trips")
async def save_trip(body: TripSave, x_client_id: str = Header(...)):
    now = datetime.now(timezone.utc).isoformat()
    row = {
        "id": str(uuid.uuid4()),
        "client_id": x_client_id,
        "destination": body.request.destination,
        "title": body.itinerary.get("title"),
        "request": body.request.model_dump(),
        "itinerary": body.itinerary,
        "image_url": body.image_url,
        "created_at": now,
        "updated_at": now,
    }
    return await store_create(row)


@app.put("/api/trips/{trip_id}")
async def update_trip(trip_id: str, body: TripSave, x_client_id: str = Header(...)):
    return await store_update(trip_id, x_client_id, {
        "destination": body.request.destination,
        "title": body.itinerary.get("title"),
        "request": body.request.model_dump(),
        "itinerary": body.itinerary,
        "image_url": body.image_url,
    })


@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: str, x_client_id: str = Header(...)):
    await store_delete(trip_id, x_client_id)
    return {"deleted": trip_id}
