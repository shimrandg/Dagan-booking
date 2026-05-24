# שרת קביעת פגישות — דגן שימרן

## התקנה מקומית

```bash
npm install
cp .env.example .env
# ערוך את .env עם הפרטים שלך
node server.js
```

## API Endpoints

| Method | Path | תיאור |
|--------|------|-------|
| GET | `/` | בדיקת סטטוס |
| GET | `/auth` | התחברות ל-Google |
| GET | `/auth/callback` | Callback אחרי אישור |
| GET | `/busy?date=YYYY-MM-DD` | שעות תפוסות לתאריך |
| POST | `/book` | קביעת פגישה |

## POST /book — Body

```json
{
  "name": "ישראל ישראלי",
  "email": "israel@example.com",
  "phone": "050-0000000",
  "date": "2025-06-15",
  "time": "10:00",
  "type": "video",
  "topic": "ייעוץ",
  "notes": "הערות"
}
```

## פריסה ל-Render

1. דחוף את הקוד ל-GitHub (ריפוזיטורי פרטי!)
2. פתח חשבון ב-render.com
3. New → Web Service → חבר את ה-Repo
4. הוסף את משתני הסביבה מ-.env.example
5. שנה את REDIRECT_URI ל-URL של Render שלך
6. Deploy!
7. כנס ל-`your-render-url.onrender.com/auth` לחיבור Google
