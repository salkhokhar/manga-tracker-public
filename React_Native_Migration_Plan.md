# React Native Migration Plan
**Manga Tracker → Mobile App (iOS & Android)**

This document outlines the architectural changes, workload, and technical steps required to convert the existing Python/VanillaJS desktop application into a standalone React Native mobile app that performs **web scraping locally** to bypass Cloudflare.

---

## 1. Architectural Shift
Currently, the app uses a Client/Server architecture where the frontend (HTML/JS) talks to the backend (Python/Flask) which talks to a hidden browser (Playwright) and a database (SQLite).

In React Native, **the entire app is the frontend**. 
- **Python/Flask** completely disappears.
- **Playwright** is replaced by an **Invisible Native WebView**.
- **Python SQLite** is replaced by **Expo SQLite** (running directly on the phone).
- **Vanilla HTML/CSS** is rebuilt using **React Native Components** (`<View>`, `<Text>`).

---

## 2. Phase 1: Project Setup & Foundation
**Estimated Effort:** Low
* **Initialize Expo:** Use Expo (a framework for React Native) to bootstrap the project, which handles native iOS/Android compilation easily.
* **Supabase Integration:** Install `@supabase/supabase-js`. The native Javascript SDK handles authentication, profiles, and reading history synchronization exactly like the Python backend did, but directly from the phone.
* **Local Database Setup:** Install `expo-sqlite`. Create a data service that executes the exact same SQL `CREATE TABLE` strings that exist in `DataEngine` to recreate your schema locally on the phone.

---

## 3. Phase 2: UI Translation
**Estimated Effort:** Moderate
React Native does not use HTML div elements or CSS files. You will need to translate the existing UI.
* **Dashboard Component:** Rebuild the grid of manga covers using a `<FlatList>` for smooth scrolling. 
* **Explore Component:** Rebuild the search filters and site fetching mechanism.
* **Detail/Reader Component:** Construct the chapter list and the vertical-scroll reader for images. The logic (managing state, next/prev chapter) will be similar to your current `app.js`, just using React state.
* **Theming:** Convert your CSS CSS variables (`--bg`, `--text`) into a React context or use an Expo theming tool.

---

## 4. Phase 3: The "Hidden WebView" Scraper Engine (The Core Challenge)
**Estimated Effort:** High
Since we can't use Python Playwright on iOS/Android, we must build a system to secretly open sites like AsuraScans natively to bypass their IP/Bot protection.

1. **The WebView Manager:** Create a hidden React Native `<WebView>` component that stays mounted in the background of your app.
2. **Navigation:** When the user clicks "Refresh Library", feed the WebView the URL of the manga. Since it's a native Safari/Chrome wrapper, Cloudflare will see it as a legitimate mobile phone crossing their firewall, and allow it.
3. **Javascript Injection:** We will repurpose your `scrapers/*.json` config files. We'll write a single Javascript function that takes your JSON rules, parses the DOM, and extracts the text/images. We will pass this code into the WebView using the `injectedJavaScript` prop.
4. **Data Bridge:** The injected JS executes inside the WebView, compiles the findings, and triggers `window.ReactNativeWebView.postMessage(data)`.
5. **Collection:** The main React Native app listens on the `onMessage` event, receives the scraped data, and saves it into `expo-sqlite`.

> [!TIP] Code Reusability
> The beauty of this approach is that your `asurascans.com.json` rule files **do not need to change at all.** The extraction logic relies on CSS selectors, which are universally understood!

---

## 5. Phase 4: Background Syncing & Notifications
**Estimated Effort:** Moderate
* **Background Fetch:** On mobile devices, apps are frozen when suspended. To maintain background syncing, we would implement `expo-background-fetch`. The OS allows apps to wake up for ~15 minutes a day to run tasks. During this brief window, we would sequentially run the Hidden WebView scraper for outdated series.
* **Push Notifications:** If a new chapter is detected during the background fetch, use `expo-notifications` to fire a native iOS/Android lock screen notification (e.g. *"Solo Leveling Chapter 180 is out!"*).

---

## Summary
The migration is absolutely feasible and represents the **industry-standard** way that aggregator reader apps operate on mobile. 
- You lose the convenience of Python.
- You gain the massive advantage of a portable app that natively bypasses almost all anti-bot protections using your personal residential network.
