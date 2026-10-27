# Wayfarer: Personalized Travel Itinerary Planner

React (Vite) + FastAPI + Supabase + Groq AI + Unsplash.
Works out of the box with NO API keys (offline starter plans + local JSON storage). Add keys to switch on the real integrations.

## Run it (two terminals)

**1. Backend**
```
cd backend
python -m venv venv
venv\Scripts\activate          # Windows   (Mac/Linux: source venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env         # Mac/Linux: cp .env.example .env
uvicorn main:app --reload
```
API: http://127.0.0.1:8000/docs

**2. Frontend**
```
cd frontend
npm install
npm run dev
```
Open http://localhost:5173

## Turn on the integrations (edit backend/.env)
| Variable | Where to get it |
|---|---|
| GROQ_API_KEY | console.groq.com -> API Keys (free tier) |
| UNSPLASH_ACCESS_KEY | unsplash.com/developers -> New Application |
| SUPABASE_URL, SUPABASE_KEY | Supabase project -> Settings -> API (use the service_role key; keep it server-side only) |

For Supabase, run `backend/schema.sql` in the SQL editor first. Restart uvicorn after editing `.env`.
The UI header on the first screen shows which engine/storage is active.

## Deploy (matches the architecture diagram)
- Backend on Render: root `backend`, build `pip install -r requirements.txt`, start `uvicorn main:app --host 0.0.0.0 --port $PORT`, add env vars and set `FRONTEND_ORIGIN` to your Vercel URL.
- Frontend on Vercel: root `frontend`, set `VITE_API_URL` to your Render URL.

## Features
Trip builder (destination, days, budget, travelers, style, interests) · AI itinerary · edit times/titles/costs · add/remove activities · regenerate any single day · live budget meter · save/open/delete trips · print view.
