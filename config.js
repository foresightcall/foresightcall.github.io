// Site settings. Edit this file to rename the site or connect the fan-voting database.
window.SITE_CONFIG = {
  // Your site name. Change it here and it updates everywhere on the page.
  siteName: "FORESIGHT CALL",

  // Fan voting (optional). Leave both empty to run in demo mode, where picks
  // are saved only in the visitor's own browser. See README.md, step 3.
  supabaseUrl: "https://ilgublzzndfneyrufnom.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsZ3VibHp6bmRmbmV5cnVmbm9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NjgxNTEsImV4cCI6MjExMDI0NDE1MX0.n3g5cp7zW5SIZ7l08wXqVF8ha36I4uq5Nqyesz6vA24",

  // Scoring. If you change these, change the matching numbers in supabase/schema.sql.
  pointsCorrect: 3,       // points for a correct pick
  bonusPoints: 2,         // extra points for calling an underdog
  bonusBelowPercent: 25,  // a pick counts as an underdog call below this model chance

  // Level ladder: points needed, and how many picks per week each level gets.
  levels: [
    { name: "Rookie",     min: 0,   picks: 3 },
    { name: "Substitute", min: 10,  picks: 4 },
    { name: "Starter",    min: 25,  picks: 5 },
    { name: "Captain",    min: 50,  picks: 7 },
    { name: "Legend",     min: 100, picks: 10 }
  ]
};
