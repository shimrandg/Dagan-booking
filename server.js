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

    // המר לטווחים בשעון ישראל
    const busyRanges = busyPeriods.map(period => {
      const start = new Date(period.start);
      const end = new Date(period.end);

      const toIsrael = (d) => {
        const israelStr = d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
        const israelDate = new Date(israelStr);
        return `${String(israelDate.getHours()).padStart(2,'0')}:${String(israelDate.getMinutes()).padStart(2,'0')}`;
      };

      return { start: toIsrael(start), end: toIsrael(end) };
    });

    res.json({ date, busy: busyRanges });

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
      attendees: [
        { email },                              // הלקוח
        { email: 'shimrandg@gmail.com', organizer: true } // דגן — מקבל התראה
      ],
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

// ─── GET: מצא פגישה לפי אימייל ───────────────────────────────────────────
// GET /appointment?email=xxx@gmail.com
app.get('/appointment', async (req, res) => {
  if (!savedTokens) return res.status(401).json({ error: 'לא מחובר' });

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'חסר אימייל' });

  try {
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + 21);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      q: email,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = (response.data.items || []).filter(e =>
      e.attendees && e.attendees.some(a => a.email === email)
    );

    if (events.length === 0) {
      return res.json({ found: false });
    }

    const event = events[0];
    const startDate = new Date(event.start.dateTime);
    const hoursUntil = (startDate - now) / (1000 * 60 * 60);

    const toIsraelTime = (d) => {
      const s = d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
      return new Date(s);
    };

    const israelStart = toIsraelTime(startDate);

    res.json({
      found: true,
      eventId: event.id,
      date: `${israelStart.getFullYear()}-${String(israelStart.getMonth()+1).padStart(2,'0')}-${String(israelStart.getDate()).padStart(2,'0')}`,
      time: `${String(israelStart.getHours()).padStart(2,'0')}:${String(israelStart.getMinutes()).padStart(2,'0')}`,
      summary: event.summary,
      canModify: hoursUntil >= 24
    });

  } catch (err) {
    console.error('Find error:', err.message);
    res.status(500).json({ error: 'שגיאה בחיפוש פגישה' });
  }
});

// ─── DELETE: ביטול פגישה ──────────────────────────────────────────────────
// DELETE /appointment?eventId=xxx&email=xxx
app.delete('/appointment', async (req, res) => {
  if (!savedTokens) return res.status(401).json({ error: 'לא מחובר' });

  const { eventId, email } = req.query;
  if (!eventId || !email) return res.status(400).json({ error: 'חסרים פרטים' });

  try {
    // בדוק שהפגישה שייכת לאימייל הזה ושיש 24 שעות
    const event = await calendar.events.get({ calendarId: 'primary', eventId });
    const startDate = new Date(event.data.start.dateTime);
    const hoursUntil = (startDate - new Date()) / (1000 * 60 * 60);

    if (hoursUntil < 24) {
      return res.status(403).json({ error: 'לא ניתן לבטל פחות מ-24 שעות לפני הפגישה' });
    }

    const isAttendee = event.data.attendees?.some(a => a.email === email);
    if (!isAttendee) {
      return res.status(403).json({ error: 'לא נמצאה פגישה עם האימייל הזה' });
    }

    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all'
    });

    res.json({ success: true, message: 'הפגישה בוטלה בהצלחה' });

  } catch (err) {
    console.error('Cancel error:', err.message);
    res.status(500).json({ error: 'שגיאה בביטול הפגישה' });
  }
});

// ─── PUT: שינוי פגישה ────────────────────────────────────────────────────
// PUT /appointment  { eventId, email, date, time }
app.put('/appointment', async (req, res) => {
  if (!savedTokens) return res.status(401).json({ error: 'לא מחובר' });

  const { eventId, email, date, time } = req.body;
  if (!eventId || !email || !date || !time) {
    return res.status(400).json({ error: 'חסרים פרטים' });
  }

  try {
    const event = await calendar.events.get({ calendarId: 'primary', eventId });
    const startDate = new Date(event.data.start.dateTime);
    const hoursUntil = (startDate - new Date()) / (1000 * 60 * 60);

    if (hoursUntil < 24) {
      return res.status(403).json({ error: 'לא ניתן לשנות פחות מ-24 שעות לפני הפגישה' });
    }

    const isAttendee = event.data.attendees?.some(a => a.email === email);
    if (!isAttendee) {
      return res.status(403).json({ error: 'לא נמצאה פגישה עם האימייל הזה' });
    }

    const newStart = new Date(`${date}T${time}:00`);
    const newEnd = new Date(newStart.getTime() + 55 * 60 * 1000);

    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: {
        start: { dateTime: newStart.toISOString(), timeZone: 'Asia/Jerusalem' },
        end: { dateTime: newEnd.toISOString(), timeZone: 'Asia/Jerusalem' }
      },
      sendUpdates: 'all'
    });

    res.json({ success: true, message: 'הפגישה עודכנה בהצלחה' });

  } catch (err) {
    console.error('Reschedule error:', err.message);
    res.status(500).json({ error: 'שגיאה בשינוי הפגישה' });
  }
});


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
