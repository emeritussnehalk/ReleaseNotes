# Jira API Setup

This app can now load release notes directly from Jira through the included Node backend.

## What I Need From You

- Jira site URL, for example `https://your-domain.atlassian.net`
- Jira account email to use for read access
- A Jira API token for that account
- The JQL that defines release-note issues
- Confirmation that these Jira custom field names are correct:
  - `Description for RN`
  - `University Name`
  - `Program Name`
  - `Business Unit`
  - `Business Docs`
  - `Tutorial Doc`
  - `Skill Set`
  - `Product Manager`
  - `Business Impact`
  - `Release Date`
- If any field name differs or appears more than once in Jira, provide its `customfield_xxxxx` ID
- Two or three sample issue keys to validate parent/story/sub-task behavior

## Local Setup

1. Copy `.env.example` to `.env`.
2. Fill these required values:

```txt
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your.email@example.com
JIRA_API_TOKEN=your-api-token
JIRA_JQL=project in (portal_em_jforce, salesforce-emeritus-jforce) AND worktype NOT IN (Test,"Test ", "Test Execution", "Test Plan", "Test Set",Bug) AND status = Done AND "Release Notes Sent?[Dropdown]" = Yes ORDER BY created DESC
```

3. Start the app:

```powershell
.\start-local-server.ps1
```

or:

```bash
npm start
```

4. Open `http://localhost:8000/`.

The backend refreshes Jira data when the server starts and then automatically on the 1st of each month at 10:00 local server time. The UI also has a protected `Sync` button for an immediate refresh; configure `SYNC_USERNAME` and `SYNC_PASSWORD` in `.env`. If Jira is not configured or the backend is not running, the page falls back to `data/master.csv`.

## Field Overrides

If Jira field names do not match exactly, set the matching field ID in `.env`:

```txt
JIRA_FIELD_RELEASE_DATE=customfield_12345
JIRA_FIELD_BUSINESS_IMPACT=customfield_23456
```

Use this for any of the optional `JIRA_FIELD_*` values listed in `.env.example`.
