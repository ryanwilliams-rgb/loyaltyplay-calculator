// netlify/functions/sensortower-dau.js
//
// Securely proxies a Sensor Tower lookup so the browser never sees the API token.
// Flow: search for the app by name -> grab its unified_app_id -> fetch active users.
//
// SETUP REQUIRED (one-time, in the Netlify dashboard):
//   Site settings > Environment variables > add SENSOR_TOWER_AUTH_TOKEN
//   (paste the token from https://sensortower.com/users/edit)
//
// NOTE ON THE ACTIVE-USERS STEP:
//   Sensor Tower's exact endpoint/params for active users can vary slightly by
//   account/plan tier, and their full docs are gated behind a signed-in session,
//   so this uses the most common documented shape. If you get an error back in
//   the calculator's status line, that error message is the RAW response Sensor
//   Tower sent us -- read it, then adjust the ACTIVE_USERS path/params below to
//   match what your account's docs say. Everything else (search step, response
//   shape back to the browser) will keep working once that one piece is fixed.

const BASE_URL = 'https://api.sensortower.com';

exports.handler = async (event) => {
  const appName = (event.queryStringParameters && event.queryStringParameters.app || '').trim();

  if (!appName) {
    return respond(400, { error: 'Missing "app" query parameter.' });
  }

  const authToken = process.env.SENSOR_TOWER_AUTH_TOKEN;
  if (!authToken) {
    return respond(500, { error: 'Server is missing SENSOR_TOWER_AUTH_TOKEN. Add it in Netlify site settings > Environment variables.' });
  }

  try {
    // Step 1: resolve the app name to a unified app ID.
    const searchUrl = `${BASE_URL}/v1/unified/search_entities?` + new URLSearchParams({
      entity_type: 'app',
      term: appName,
      limit: '1',
      auth_token: authToken
    });

    const searchRes = await fetch(searchUrl);
    const searchBody = await safeJson(searchRes);

    if (!searchRes.ok) {
      return respond(searchRes.status, {
        error: `Sensor Tower search failed (${searchRes.status}): ${describeError(searchBody)}`
      });
    }

    const match = Array.isArray(searchBody) ? searchBody[0] : (searchBody.apps && searchBody.apps[0]);
    if (!match || !match.app_id) {
      return respond(404, {
        error: `No app found matching "${appName}".`,
        debug_raw_response: searchBody
      });
    }

    const unifiedAppId = match.app_id;
    const resolvedName = match.name || match.humanized_name || appName;

    // Step 2: fetch active users for that app.
    // See the NOTE at the top of this file if this call errors out.
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const activeUsersUrl = `${BASE_URL}/v1/unified/usage/active_users?` + new URLSearchParams({
      app_ids: unifiedAppId,
      date_granularity: 'monthly',
      start_date: start,
      end_date: end,
      country: 'US',
      auth_token: authToken
    });

    const auRes = await fetch(activeUsersUrl);
    const auBody = await safeJson(auRes);

    if (!auRes.ok) {
      return respond(auRes.status, {
        error: `Sensor Tower active-users lookup failed (${auRes.status}): ${describeError(auBody)}`
      });
    }

    const dau = extractDau(auBody);
    if (dau == null) {
      return respond(502, { error: 'Sensor Tower returned data but no DAU field was recognized. Raw response: ' + JSON.stringify(auBody).slice(0, 300) });
    }

    return respond(200, { appName: resolvedName, unifiedAppId, dau });
  } catch (err) {
    return respond(500, { error: 'Unexpected error: ' + err.message });
  }
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  };
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function describeError(body) {
  if (!body) return 'no response body';
  if (typeof body === 'string') return body.slice(0, 200);
  return (body.error || body.message || JSON.stringify(body)).toString().slice(0, 200);
}

// Sensor Tower's active-users response shape can differ by endpoint version;
// this tries a few common layouts so small differences don't break everything.
function extractDau(body) {
  if (!body) return null;
  if (Array.isArray(body) && body.length) {
    const row = body[body.length - 1]; // most recent period
    if (row.dau != null) return row.dau;
    if (row.users != null) return row.users;
    if (row.active_users != null) return row.active_users;
  }
  if (body.dau != null) return body.dau;
  if (body.data && Array.isArray(body.data) && body.data.length) {
    return extractDau(body.data);
  }
  return null;
}
