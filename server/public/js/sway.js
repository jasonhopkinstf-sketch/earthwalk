// Wind in the trees: every tree's crown leans to and fro together, in gusts that travel across the land.
// The sums are the Windows game's (SwayCode in its foliage material): a gust is two waves, one riding on
// the other, and it reaches each tree a little later than its neighbour upwind. How far the crowns lean
// is the weather's business (weather.js sets `wind.sway` from weatherdata.js).

import * as THREE from "three";

/** How far the crowns lean in a gust (metres), which way the wind blows (east, south), and the wind's own clock. */
export const wind = { sway: { value: 0.08 }, dir: { value: new THREE.Vector2(1, 0) }, time: { value: 0 } };

/** What makes a tree part's material lean with the wind: for `paint`'s `patch` (look.js). */
export const swayPatch = (shader) => {
  shader.uniforms.uSway = wind.sway;
  shader.uniforms.uSwayDir = wind.dir;
  shader.uniforms.uSwayTime = wind.time;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nuniform float uSway;\nuniform vec2 uSwayDir;\nuniform float uSwayTime;")
    .replace("#include <begin_vertex>", `#include <begin_vertex>
#ifdef USE_INSTANCING
  {
    // Where the tree stands says when the gust reaches it; the top of the shape moves most.
    vec3 stands = instanceMatrix[3].xyz;
    float phase = uSwayTime * 1.7 + stands.x * 0.45 + stands.z * 0.33;
    float gust = sin(phase) + 0.45 * sin(phase * 2.3 + 1.7);
    float lift = 0.55 + 0.45 * clamp(position.y + 0.5, 0.0, 1.0);
    vec3 push = vec3(uSwayDir.x, 0.0, uSwayDir.y) * gust * uSway * lift;
    // (The push is in the world's metres; the shape is in its own, turned and stretched.)
    transformed.x += dot(push, instanceMatrix[0].xyz) / dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz);
    transformed.z += dot(push, instanceMatrix[2].xyz) / dot(instanceMatrix[2].xyz, instanceMatrix[2].xyz);
  }
#endif`);
};
