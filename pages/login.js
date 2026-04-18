// ─────────────────────────────────────────────────────────────────────
// pages/login.js — Template HTML de la page de login (non-auth)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/')
// ─────────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 36px 40px; width: 340px; }
  h1 { font-size: 22px; font-weight: 700; color: #fff; text-align: center; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #80848e; text-align: center; margin-bottom: 28px; }
  label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #b5bac1; margin-bottom: 6px; }
  input[type=password] { width: 100%; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 10px 12px; font-size: 14px; outline: none; margin-bottom: 20px; }
  input[type=password]:focus { border-color: #5865f2; }
  button { width: 100%; background: #5865f2; border: none; border-radius: 4px; color: #fff; font-size: 15px; font-weight: 600; padding: 11px; cursor: pointer; }
  button:hover { background: #4752c4; }
  .err { background: #3a1e1e; border: 1px solid #ed424544; color: #ed4245; border-radius: 4px; padding: 8px 12px; font-size: 13px; margin-bottom: 16px; display: none; }
  .err.show { display: block; }
</style>
</head>
<body>
<div class="card">
  <h1>&#x1F525; BOOM</h1>
  <p class="sub">Signal Monitor Dashboard</p>
  <form method="POST" action="/login">
    <div id="err" class="err">Mot de passe incorrect</div>
    <label for="pw">Mot de passe</label>
    <input type="password" id="pw" name="password" autofocus placeholder="••••••••">
    <button type="submit">Se connecter</button>
  </form>
</div>
</body>
</html>`;
module.exports = { LOGIN_HTML };