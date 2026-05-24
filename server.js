require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // בפרודקשן - החלף ל-URL האתר שלך

// ─── Google OAuth2 Setup ──────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
);

// טען טוקן שמור אם קיים
let savedTokens = null;
if (process.env.GOOGLE_REFRESH_TOKEN) {
  savedTokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  oauth2Client.setCredentials(savedTokens);
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ─── AUTH: שלב 1 — הפנה ל-Google ─────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  });
  res.redirect(url);
});

// ─── AUTH: שלב 2 — קבל טוקן אחרי אישור ──────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    savedTokens = tokens;

    // הצג את ה-refresh token — העתק אותו ל-.env
    res.send(`
      <html dir="rtl" style="font-family:Arial; padding:40px; text-align:center;">
        <h2>✅ החיבור הצליח!</h2>
        <p>העתק את ה-Refresh Token הזה ושמור אותו ב-.env שלך:</p>
        <code style="background:#f0f0f0; padding:12px; display:block; margin:20px; border-radius:8px; word-break:break-all; font-size:0.85rem;">
          GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}
        </code>
        <p style="color:#666;">לאחר שהוספת אותו ל-.env, הפעל מחדש את השרת. זהו!</p>
      </html>
    `);
  } catch (err) {
    res.status(500).send('שגיאה בהתחברות: ' + err.message);
  }
});

// ─── GET: שעות תפוסות לתאריך ──────────────────────────────────────────────
// GET /busy?date=2025-06-10
app.get('/busy', async (req, res) => {
  if (!savedTokens) {
    return res.status(401).json({ error: 'לא מחובר ל-Google Calendar. כנס ל-/auth' });
  }

  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'חסר פרמטר date' });

  try {
    // בדוק שהטוקן תקף
    if (savedTokens.expiry_date && Date.now() > savedTokens.expiry_date - 60000) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      savedTokens = credentials;
    }

    const startOfDay = new Date(date + 'T00:00:00');
    const endOfDay   = new Date(date + 'T23:59:59');

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        items: [{ id: 'primary' }]
      }
    });

    const busyPeriods = response.data.calendars.primary.busy || [];

    // המר לרשימת שעות תפוסות (HH:MM)
    const busyTimes = busyPeriods.map(period => {
      const start = new Date(period.start);
      return `${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}`;
    });

    // החזר רק שעות — ללא שמות, פרטים או נושאי הפגישות
    res.json({ date, busy: busyTimes });

  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: 'שגיאה בשאילתת היומן' });
  }
});

// ─── POST: קביעת פגישה ────────────────────────────────────────────────────
// POST /book  { name, email, phone, date, time, type, topic, notes }
app.post('/book', async (req, res) => {
  if (!savedTokens) {
    return res.status(401).json({ error: 'לא מחובר ל-Google Calendar' });
  }

  const { name, email, phone, date, time, type, topic, notes } = req.body;
  if (!name || !email || !date || !time) {
    return res.status(400).json({ error: 'חסרים שדות חובה' });
  }

  try {
    const [hour, minute] = time.split(':').map(Number);
    const startDate = new Date(`${date}T${time}:00`);
    const endDate   = new Date(startDate.getTime() + 55 * 60 * 1000); // 55 דקות

    const meetingType = type === 'video' ? 'פגישת ווידאו' : 'פגישה פיזית';
    const description = [
      `לקוח: ${name}`,
      `אימייל: ${email}`,
      phone ? `טלפון: ${phone}` : '',
      topic ? `נושא: ${topic}` : '',
      notes ? `הערות: ${notes}` : '',
      '',
      `סוג: ${meetingType}`
    ].filter(Boolean).join('\n');

    const event = {
      summary: `פגישה עם ${name}`,
      description,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'Asia/Jerusalem'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'Asia/Jerusalem'
      },
      attendees: [{ email }],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 60 },
          { method: 'popup',  minutes: 15 }
        ]
      }
    };

    // הוסף Google Meet אוטומטית לפגישות ווידאו
    if (type === 'video') {
      event.conferenceData = {
        createRequest: { requestId: `booking-${Date.now()}` }
      };
    }

    const createdEvent = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      conferenceDataVersion: type === 'video' ? 1 : 0,
      sendUpdates: 'all' // שלח הזמנה ללקוח אוטומטית
    });

    res.json({
      success: true,
      eventId: createdEvent.data.id,
      meetLink: createdEvent.data.hangoutLink || null,
      message: 'הפגישה נקבעה בהצלחה'
    });

  } catch (err) {
    console.error('Booking error:', err.message);
    res.status(500).json({ error: 'שגיאה בקביעת הפגישה' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    connected: !!savedTokens,
    message: savedTokens ? '✅ מחובר ל-Google Calendar' : '⚠️ לא מחובר — כנס ל-/auth'
  });
});

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ שרת פעיל על פורט ${PORT}`);
  console.log(`🔗 לחיבור Google Calendar: http://localhost:${PORT}/auth`);
});
