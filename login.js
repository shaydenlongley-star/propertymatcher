import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'fb-session.json');

console.log('Opening Facebook — please log in in the browser window...\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://www.facebook.com', { waitUntil: 'networkidle' });

// First confirm the login form is actually showing before we start watching
const loginForm = await page.$('input[name="email"]').catch(() => null);
if (loginForm) {
  console.log('Login page detected. Waiting for you to log in...');
} else {
  console.log('Facebook loaded. Waiting to confirm login...');
}

// Wait up to 5 minutes for the email input to disappear (login complete + any 2FA done)
let loggedIn = false;
for (let i = 0; i < 150; i++) {
  await page.waitForTimeout(2000);
  try {
    const url = page.url();
    // Skip if still on login/checkpoint/2FA pages
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/two_step')) continue;

    const emailField = await page.$('input[name="email"]');
    if (emailField) continue; // still on login page

    // Check for elements that only exist when logged in
    const profilePic = await page.$('[aria-label="Your profile"], [data-testid="royal_blue_bar"], nav[aria-label="Facebook"]');
    const feed = await page.$('[role="feed"], [data-pagelet="Feed"]');

    if (profilePic || feed || (url.includes('facebook.com') && !url.includes('login'))) {
      // Double-check: wait 2 more seconds and confirm still logged in
      await page.waitForTimeout(2000);
      const stillHasEmail = await page.$('input[name="email"]');
      if (!stillHasEmail) {
        loggedIn = true;
        break;
      }
    }
  } catch {
    // page may be navigating, keep polling
  }
}

if (!loggedIn) {
  console.log('Timed out waiting for login. Please run again.');
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(3000);
await context.storageState({ path: SESSION_FILE });
console.log('\nSession saved! Closing browser...');
await browser.close();
