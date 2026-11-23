import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { AREA_DEG, CALLS_A_DAY, CREDIT, CREDIT_URL, KEEP_MS, RETRY_MS, STALE_MS, WeatherService, areaOf, kindOf, readWeather } from "../src/weather.ts";

// The weather is a public service: here a stand-in answers for it, so nothing leaves this computer.

/** What Open-Meteo sends for `current=...` (the shape it gave on 2026-11-24), with whatever is put over it. */
const answer = (over: Record<string, number> = {}) => ({
  latitude: -36.731106, longitude: 174.68504, utc_offset_seconds: 46800, timezone: "Pacific/Auckland",
  current_units: { interval: "seconds", wind_speed_10m: "m/s", precipitation: "mm", snowfall: "cm", visibility: "m" },
  current: {
    time: "2026-11-24T09:00", interval: 900, temperature_2m: 19.1, is_day: 1, precipitation: 0, rain: 0, showers: 0, snowfall: 0,
    weather_code: 0, cloud_cover: 0, wind_speed_10m: 2.35, wind_direction_10m: 356, wind_gusts_10m: 5.8, visibility: 45100, ...over,
  },
});

async function standIn() {
  const asked: URL[] = [];
  const agents: (string | undefined)[] = [];
  const state = { status: 200, body: answer() as unknown, hang: false };
  const server: Server = createServer((req, res) => {
    asked.push(new URL(req.url ?? "/", "http://localhost"));
    agents.push(req.headers["user-agent"]);
    if (state.hang) return; // never answers
    res.writeHead(state.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state.body));
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { asked, agents, state, url: `http://localhost:${(server.address() as AddressInfo).port}/v1/forecast`, close: () => { server.closeAllConnections(); server.close(); } };
}

test("a place is rounded to a quarter of a degree, and that is all the service is told", () => {
  assert.equal(AREA_DEG, 0.25);
  assert.deepEqual(areaOf(-36.8312, 174.7965), { lat: -36.75, lon: 174.75 });
  assert.deepEqual(areaOf(48.8583, 2.2945), { lat: 48.75, lon: 2.25 });
  assert.deepEqual(areaOf(0.1, -0.1), { lat: 0, lon: -0 });
  assert.deepEqual(areaOf(10, 179.95), { lat: 10, lon: -180 }, "the two edges of the map are one place");
  assert.deepEqual(areaOf(89.99, 0), { lat: 90, lon: 0 });
});

test("the service's codes are sorted into the kinds of weather a game draws", () => {
  const kinds: Record<string, number[]> = {
    fine: [0, 1, 2], cloudy: [3], fog: [45, 48], drizzle: [51, 53, 55, 56, 57], rain: [61, 63, 65, 66, 67, 80, 81, 82],
    snow: [71, 73, 75, 77, 85, 86], storm: [95, 96, 99],
  };
  for (const [kind, codes] of Object.entries(kinds)) for (const code of codes) assert.equal(kindOf(code), kind, `code ${code}`);
  assert.equal(kindOf(1, 0.8), "cloudy", "a clear code under a sky that is mostly cloud is cloudy");
  assert.equal(kindOf(2, 0.4), "fine");
});

test("what the service sends is read into plain numbers, by the hour", () => {
  const area = { lat: -36.75, lon: 174.75 };
  const fine = readWeather(answer(), area, 1000)!;
  assert.deepEqual(fine, {
    lat: -36.75, lon: 174.75, at: 1000, kind: "fine", code: 0, cloud: 0, rain: 0, snow: 0, wind: 2.4, gust: 5.8, windFrom: 356,
    temp: 19.1, visibility: 45100, day: true, utcOffset: 46800, credit: "Weather data by Open-Meteo.com", creditUrl: "https://open-meteo.com/",
  });
  // 0.6 mm of rain and 0.2 of showers in a quarter of an hour is 3.2 mm an hour.
  const wet = readWeather(answer({ weather_code: 63, rain: 0.6, showers: 0.2, precipitation: 0.8, cloud_cover: 100, is_day: 0 }), area, 1)!;
  assert.deepEqual([wet.kind, wet.rain, wet.cloud, wet.day], ["rain", 3.2, 1, false]);
  const white = readWeather(answer({ weather_code: 73, snowfall: 0.35, temperature_2m: -3.2 }), area, 1)!;
  assert.deepEqual([white.kind, white.snow, white.temp], ["snow", 1.4, -3.2]);
  assert.equal(readWeather(answer({ weather_code: 45, visibility: 180 }), area, 1)!.kind, "fog");
  // Nonsense is not weather, and silly numbers are kept within reason.
  for (const not of [null, {}, { current: {} }, { current: { weather_code: "rain" } }, "sunny"]) assert.equal(readWeather(not, area, 1), null);
  const wild = readWeather(answer({ wind_speed_10m: 9999, cloud_cover: 250, rain: -5, wind_direction_10m: 725 }), area, 1)!;
  assert.deepEqual([wild.wind, wild.cloud, wild.rain, wild.windFrom], [100, 1, 0, 5]);
  assert.equal(CREDIT, "Weather data by Open-Meteo.com");
  assert.equal(CREDIT_URL, "https://open-meteo.com/");
});

test("the service is asked once for an area and a quarter of an hour, whoever asks", async () => {
  const fake = await standIn();
  let clock = Date.parse("2026-11-24T02:00:00Z");
  const service = new WeatherService({ url: fake.url, now: () => clock });
  try {
    fake.state.body = answer({ weather_code: 61, rain: 0.3, cloud_cover: 90 });
    // Devonport and Queens Wharf are in one area; three people asking at once are one question.
    const [a, b, c] = await Promise.all([service.at(-36.8312, 174.7965), service.at(-36.841, 174.7683), service.at(-36.8312, 174.7965)]);
    assert.equal(a?.kind, "rain");
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    assert.equal(fake.asked.length, 1);
    const q = fake.asked[0].searchParams;
    assert.deepEqual([q.get("latitude"), q.get("longitude")], ["-36.75", "174.75"], "only the middle of the area is sent");
    assert.equal(q.get("wind_speed_unit"), "ms");
    assert.match(q.get("current") ?? "", /weather_code/);
    assert.deepEqual([...q.keys()].sort(), ["current", "latitude", "longitude", "timezone", "wind_speed_unit"], "and nothing about who is asking");
    assert.deepEqual(fake.agents, ["earthwalk-server"], "not even the contact address the map services are given");
    // Fourteen minutes on: still the kept answer. Sixteen: asked again.
    clock += 14 * 60_000;
    assert.equal((await service.at(-36.8, 174.8))?.kind, "rain");
    assert.equal(fake.asked.length, 1);
    assert.equal(service.wouldAsk(-36.8, 174.8), false);
    clock += 2 * 60_000;
    assert.equal(service.wouldAsk(-36.8, 174.8), true);
    fake.state.body = answer({ weather_code: 3, cloud_cover: 100 });
    assert.equal((await service.at(-36.8, 174.8))?.kind, "cloudy");
    assert.equal(fake.asked.length, 2);
    // Somewhere else is another question.
    assert.equal((await service.at(48.8583, 2.2945))?.lat, 48.75);
    assert.equal(fake.asked.length, 3);
    assert.equal(service.calls, 3);
    assert.equal(KEEP_MS, 15 * 60_000);
  } finally {
    fake.close();
  }
});

test("when the service does not answer, the last answer does for two hours, and then there is none", async () => {
  const fake = await standIn();
  let clock = Date.parse("2026-11-24T02:00:00Z");
  const service = new WeatherService({ url: fake.url, now: () => clock, timeoutMs: 300 });
  const quiet = console.error;
  console.error = () => undefined; // (the failures below are meant)
  try {
    fake.state.body = answer({ weather_code: 71, snowfall: 0.2 });
    assert.equal((await service.at(60, 10))?.kind, "snow");
    // The service breaks: the snow goes on, and it is not asked again at once.
    fake.state.status = 500;
    clock += KEEP_MS + 1000;
    assert.equal((await service.at(60, 10))?.kind, "snow");
    assert.equal(fake.asked.length, 2);
    clock += RETRY_MS - 5000;
    assert.equal((await service.at(60, 10))?.kind, "snow");
    assert.equal(fake.asked.length, 2, "left alone for two minutes after a failure");
    // It sends nonsense, then nothing at all: the same.
    fake.state.status = 200;
    fake.state.body = { hello: "world" };
    clock += 10_000;
    assert.equal((await service.at(60, 10))?.kind, "snow");
    fake.state.hang = true;
    clock += RETRY_MS + 1000;
    assert.equal((await service.at(60, 10))?.kind, "snow");
    assert.equal(fake.asked.length, 4);
    // Two hours after the last real answer, there is no weather to give.
    clock = Date.parse("2026-11-24T02:00:00Z") + STALE_MS + 1000;
    assert.equal(await service.at(60, 10), null);
    // A place never answered for has none either, and nothing is thrown.
    assert.equal(await service.at(-10, -50), null);
    // It comes back: so does the weather.
    fake.state.hang = false;
    fake.state.body = answer({ weather_code: 0 });
    clock += RETRY_MS + 1000;
    assert.equal((await service.at(60, 10))?.kind, "fine");
    // A service that is not there at all.
    const nowhere = new WeatherService({ url: "http://127.0.0.1:9/none", timeoutMs: 300 });
    assert.equal(await nowhere.at(1, 2), null);
  } finally {
    console.error = quiet;
    fake.close();
  }
});

test("there is a ceiling on the calls of a day, far under the service's own", async () => {
  const fake = await standIn();
  let clock = Date.parse("2026-11-24T02:00:00Z");
  const service = new WeatherService({ url: fake.url, now: () => clock });
  try {
    assert.ok(CALLS_A_DAY <= 5000, "the service allows 10,000 a day");
    service.calls = CALLS_A_DAY - 1;
    (service as unknown as { day: string }).day = "2026-11-24";
    assert.equal((await service.at(1, 1))?.kind, "fine");
    assert.equal(await service.at(2, 2), null, "the day's calls are spent");
    assert.equal(fake.asked.length, 1);
    assert.equal((await service.at(1, 1))?.kind, "fine", "what is kept is still given");
    clock += 24 * 3600_000; // tomorrow
    assert.equal((await service.at(2, 2))?.kind, "fine");
  } finally {
    fake.close();
  }
});

test("GET /v1/weather gives the weather of the district, and 503 when there is none", async () => {
  const fake = await standIn();
  const quiet = console.error;
  const app = createApp({
    accessCode: "otter-42", weather: new WeatherService({ url: fake.url, timeoutMs: 300 }), weatherLimit: 3,
    buildChunk: async () => Buffer.from("chunk"), readCache: async () => null, writeCache: async () => undefined,
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  const code = { headers: { Authorization: "Bearer otter-42" } };
  try {
    assert.equal((await fetch(`${base}/v1/weather?lat=-36.8312&lon=174.7965`)).status, 401, "it takes the access code like the rest");
    assert.equal((await fetch(`${base}/v1/weather?lat=abc&lon=2`, code)).status, 400);
    assert.equal((await fetch(`${base}/v1/weather?lat=95&lon=2`, code)).status, 400);
    assert.equal((await fetch(`${base}/v1/weather`, code)).status, 400);
    assert.equal(fake.asked.length, 0);

    fake.state.body = answer({ weather_code: 65, rain: 2.1, cloud_cover: 100, wind_speed_10m: 9.4, wind_direction_10m: 240, wind_gusts_10m: 15.2 });
    const res = await fetch(`${base}/v1/weather?lat=-36.8312&lon=174.7965`, code);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, max-age=300");
    const weather = await res.json();
    assert.deepEqual({ ...weather, at: 0 }, {
      lat: -36.75, lon: 174.75, at: 0, kind: "rain", code: 65, cloud: 1, rain: 8.4, snow: 0, wind: 9.4, gust: 15.2, windFrom: 240,
      temp: 19.1, visibility: 45100, day: true, utcOffset: 46800, credit: "Weather data by Open-Meteo.com", creditUrl: "https://open-meteo.com/",
    });
    assert.ok(Math.abs(weather.at - Date.now()) < 5000);
    // The same district again: not asked of the service again.
    assert.equal((await fetch(`${base}/v1/weather?lat=-36.841&lon=174.7683`, code)).status, 200);
    assert.equal(fake.asked.length, 1);

    // The service is down, somewhere it has never answered for: no weather, said plainly, and the server stands.
    console.error = () => undefined;
    fake.state.status = 502;
    const none = await fetch(`${base}/v1/weather?lat=48.8583&lon=2.2945`, code);
    assert.equal(none.status, 503);
    assert.match((await none.json()).error, /no weather/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    // One address hopping all over the map is stopped before it spends the day's calls: three new districts here.
    assert.equal((await fetch(`${base}/v1/weather?lat=10&lon=10`, code)).status, 503);
    const stopped = await fetch(`${base}/v1/weather?lat=20&lon=20`, code);
    assert.equal(stopped.status, 429);
    assert.equal(stopped.headers.get("retry-after"), "120");
    assert.equal(fake.asked.length, 3);
    assert.equal((await fetch(`${base}/v1/weather?lat=-36.8312&lon=174.7965`, code)).status, 200, "a district already known is still given");
  } finally {
    console.error = quiet;
    app.close();
    fake.close();
  }
});

test("with the weather turned off the route says so and nothing is asked", async () => {
  const app = createApp({ weather: null, buildChunk: async () => Buffer.from("chunk"), readCache: async () => null, writeCache: async () => undefined });
  await new Promise<void>((r) => app.server.listen(0, r));
  try {
    assert.equal((await fetch(`http://localhost:${(app.server.address() as AddressInfo).port}/v1/weather?lat=1&lon=2`)).status, 503);
  } finally {
    app.close();
  }
});
