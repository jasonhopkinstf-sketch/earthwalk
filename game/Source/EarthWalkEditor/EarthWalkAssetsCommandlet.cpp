#include "EarthWalkAssetsCommandlet.h"

#include "AssetToolsModule.h"
#include "Factories/MaterialFactoryNew.h"
#include "IAssetTools.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Engine/BlendableInterface.h"
#include "Materials/MaterialExpressionCameraPositionWS.h"
#include "Materials/MaterialExpressionCameraVectorWS.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionLocalPosition.h"
#include "Materials/MaterialExpressionPerInstanceCustomData.h"
#include "Materials/MaterialExpressionPerInstanceRandom.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionSceneTexture.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionTime.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Materials/MaterialExpressionVertexNormalWS.h"
#include "Materials/MaterialExpressionWorldPosition.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

DEFINE_LOG_CATEGORY_STATIC(LogEarthWalkAssets, Log, All);

namespace
{
	const TCHAR* const MaterialPath = TEXT("/Game/EarthWalk/Materials");

	// The look is a drawn cartoon: flat painted colours, matt, with a little brushwork, and patterns
	// that say "tiles" or "bricks" rather than photographs of them. M_EarthInk then bands the light and
	// draws the outlines. Nothing here uses a texture: every mark is worked out from where the surface is.
	//
	// Three dials make the same materials a second look, flat like a television cartoon (EarthLook.cpp
	// sets them): Flat takes the brushwork out and leaves one even colour, Vivid makes the colour
	// brighter than it was sent, and Marks is how strongly the drawn patterns show.

	/** Ground, roads and roofs: the colour, a little uneven as if brushed on, with a drawn pattern for some surfaces. */
	const TCHAR* const TopCode = TEXT(R"HLSL(
float3 n = normalize(Normal);
float2 p = WorldPos.xy / 100.0; // metres
float h = WorldPos.z / 100.0;
float detail = 1.0 - saturate((length(WorldPos - CamPos) - 7000.0) / 11000.0); // drawn marks fade out with distance
float blot = sin(p.x * 0.11 + 1.7 * sin(p.y * 0.07)) * sin(p.y * 0.13 + 1.3 * sin(p.x * 0.09));
float daub = sin(p.x * 0.9 + p.y * 0.5) * sin(p.y * 1.1 - p.x * 0.4);
float grey = dot(Tint, float3(0.299, 0.587, 0.114));
float3 tint = max(lerp(float3(grey, grey, grey), Tint, 1.0 + Vivid), 0.0); // Vivid: the colour brighter than it was sent
float3 c = tint * (1.0 + (0.13 * blot + 0.05 * daub * detail) * (1.0 - Flat));
float mark = 0.0;
if (Pattern > 0.5 && Pattern < 1.5)
{
	// Roof: rows of tiles across the slope with staggered joins, and nothing on a flat roof.
	float pitch = saturate((1.0 - n.z) * 30.0);
	float rows = h / 0.32;
	float2 d = normalize(n.xy + float2(1e-4, 0.0));
	float along = dot(p, float2(d.y, -d.x));
	float join = frac(along / 0.7 + 0.5 * floor(rows));
	mark = max(frac(rows) < 0.16 ? 1.0 : 0.0, join < 0.06 ? 0.7 : 0.0) * pitch;
}
else if (Pattern > 1.5 && Pattern < 2.5)
{
	// Farmland: furrows.
	mark = frac((p.x * 0.8 + p.y * 0.6) / 1.8) < 0.22 ? 0.55 : 0.0;
}
else if (Pattern > 2.5 && Pattern < 3.5)
{
	// Paving: slabs.
	float2 g = frac(p / 1.3);
	mark = (g.x < 0.045 || g.y < 0.045) ? 0.6 : 0.0;
}
else if (Pattern > 3.5 && Pattern < 4.5)
{
	// Grass: a scatter of strokes, one or two to a stride, each a little tilted.
	float2 cell = floor(p / 1.5);
	float rnd = frac(sin(dot(cell, float2(12.9898, 78.233))) * 43758.5453);
	float2 g = frac(p / 1.5) - 0.5 - (float2(rnd, frac(rnd * 7.31)) - 0.5) * 0.5;
	float lean = (rnd - 0.5) * 0.8;
	mark = (rnd > 0.4 && abs(g.x - g.y * lean) < 0.035 && abs(g.y) < 0.2) ? 0.8 : 0.0;
}
else if (Pattern > 4.5 && Pattern < 5.5)
{
	// Hedge: leafy dabs, darker and lighter, on every side.
	float3 q = WorldPos / 21.0;
	float dab = sin(q.x * 1.3 + 1.2 * sin(q.z * 1.7)) * sin(q.y * 1.1 + 1.2 * sin(q.x * 1.9)) * sin(q.z * 1.5 + q.y * 0.7);
	mark = smoothstep(0.18, 0.3, dab) * 0.75;
	c *= 1.0 + 0.16 * smoothstep(0.15, 0.3, -dab) * detail * Marks;
}
else if (Pattern > 5.5)
{
	// Picket fence: the gaps between the pales, on its upright faces.
	float2 d = normalize(n.xy + float2(1e-4, 0.0));
	float along = dot(p, float2(d.y, -d.x));
	mark = (frac(along / 0.17) < 0.2 ? 1.2 : 0.0) * saturate(1.0 - abs(n.z) * 4.0);
}
c *= 1.0 - 0.3 * mark * detail * Marks;
WorldNormal = n;
Rough = 0.92;
return saturate(c);
)HLSL");

	/** Building walls: painted, with patches of brick drawn in where the wall is brick, and cartoon windows. */
	const TCHAR* const WallCode = TEXT(R"HLSL(
float3 n = normalize(Normal);
float2 t2 = normalize(float2(n.y, -n.x) + float2(1e-4, 0.0));
float along = dot(WorldPos.xy, t2) / 100.0;
float height = WorldPos.z / 100.0;
float detail = 1.0 - saturate((length(WorldPos - CamPos) - 5000.0) / 8000.0);
float blot = sin(along * 0.35 + 1.4 * sin(height * 0.5)) * sin(height * 0.6 + along * 0.2);
float grey = dot(Tint, float3(0.299, 0.587, 0.114));
float3 tint = max(lerp(float3(grey, grey, grey), Tint, 1.0 + Vivid), 0.0); // Vivid: the colour brighter than it was sent
float3 wall = tint * (1.0 + 0.06 * blot * (1.0 - Flat));
// Brick the way a cartoon says it: a few patches of courses, not every brick.
float course = height / 0.3;
float2 b = frac(float2(along / 0.62 + 0.5 * floor(course), course));
float mortar = (b.x < 0.07 || b.y < 0.14) ? 1.0 : 0.0;
float clump = smoothstep(0.30, 0.55, sin(along * 0.45 + 2.0) * sin(height * 0.7 + along * 0.13 + 1.0));
wall *= 1.0 - 0.22 * mortar * clump * Bricks * detail * Marks;
// RowShift.x is where the building's ground floor sits within a 3 m storey (AEarthWorld::BuildChunk),
// so window rows count up from the ground floor rather than from sea level. RowShift.y is a number
// each building has to itself. Span is how far this point is along its wall and how long the wall
// is, in metres.
//
// Windows are spaced to fit the wall and centred in their bays, so none is cut off at a corner and a
// wall too short for one has none. A big building has one about every 2.6 m. A home has far fewer
// and no two homes quite alike: each has its own spacing, its own width of window, some windows
// left out, and now and then a short wall with none at all.
float own = RowShift.y;
float wallOwn = frac(sin(Span.y * 12.9898 + own * 78.233) * 43758.5453);
float spacing = lerp(2.6, lerp(3.4, 5.4, frac(own * 2.3)), Homely);
float bays = max(1.0, round(Span.y / spacing) - ((Homely > 0.5 && wallOwn < 0.3) ? 1.0 : 0.0));
float bayWidth = Span.y / bays;
float bay = floor(Span.x / bayWidth);
float fromMiddle = (Span.x / bayWidth - bay - 0.5) * bayWidth;
float storey = floor(height / 3.0 - RowShift.x);
float each = frac(sin(bay * 37.7 + storey * 91.3 + wallOwn * 57.1) * 43758.5453);
float blank = (Homely > 0.5 && (each < 0.16 || (Span.y < 5.0 && wallOwn > 0.86))) ? 1.0 : 0.0;
float kept = (Span.y >= 2.2 && blank < 0.5) ? 1.0 : 0.0;
float widthPick = frac(own * 6.7);
float wide = Homely > 0.5 ? (widthPick < 0.3 ? 0.8 : widthPick < 0.75 ? 1.0 : 1.4) : 1.0;
wide = min(wide, max(0.5, (bayWidth - 0.4) / 1.7)); // with its shutters a window is 1.7 m at full width
float2 f = float2(fromMiddle / (2.4 * wide) + 0.5, frac(height / 3.0 - RowShift.x));
float Win = Windows * kept;
float win = (f.x > 0.28 && f.x < 0.72 && f.y > 0.30 && f.y < 0.78) ? 1.0 : 0.0;
float frame = (f.x > 0.235 && f.x < 0.765 && f.y > 0.255 && f.y < 0.825) ? 1.0 : 0.0;
float sill = (f.x > 0.20 && f.x < 0.80 && f.y > 0.215 && f.y < 0.255) ? 1.0 : 0.0;
// Glazing bars: a cross on some homes, one upright on others, a plain pane on the rest.
float barPick = frac(own * 8.3);
float bars = ((barPick < 0.8 && abs(f.x - 0.5) < 0.011 / wide) || (barPick < 0.45 && abs(f.y - 0.56) < 0.009)) ? 1.0 : 0.0;
// The pane: sky blue, lighter towards the top, with two slanting streaks of shine. In the flat look
// it is one blue with one streak.
float2 pane = (f - float2(0.28, 0.30)) / float2(0.44, 0.48);
float slant = pane.x + pane.y;
float shine = (abs(slant - 0.72) < 0.07 || (abs(slant - 0.93) < 0.025 && Flat < 0.5)) ? 1.0 : 0.0;
float3 glass = lerp(float3(0.30, 0.56, 0.80), float3(0.52, 0.76, 0.93), pane.y);
glass = lerp(glass, float3(0.36, 0.66, 0.93), Flat);
glass = lerp(glass, float3(0.93, 0.97, 1.0), shine * 0.75 * detail);
float3 trim = float3(0.97, 0.96, 0.92);
float3 c = lerp(wall, trim * 0.9, sill * Win);
c = lerp(c, trim, frame * Win);
c = lerp(c, glass, win * Win);
c = lerp(c, trim, bars * win * Win * detail);
// Homes: shutters on some, a box of flowers under the windows of others, the same all the way round
// a house and different from its neighbours.
float home = Homely * Win;
float hasShutters = frac(own * 3.7) > 0.45 ? 1.0 : 0.0;
float hasFlowers = frac(own * 5.3) > 0.5 ? 1.0 : 0.0;
float shutter = (((f.x > 0.165 && f.x < 0.228) || (f.x > 0.772 && f.x < 0.835)) && f.y > 0.275 && f.y < 0.805) ? 1.0 : 0.0;
float pick = frac(own * 9.1);
float3 shutterPaint = pick < 0.3 ? float3(0.15, 0.36, 0.24) : pick < 0.55 ? float3(0.17, 0.28, 0.50) : pick < 0.8 ? float3(0.56, 0.16, 0.14) : float3(0.96, 0.95, 0.91);
float slat = frac(height / 0.11) < 0.22 ? 1.0 : 0.0;
c = lerp(c, shutterPaint * (1.0 - 0.2 * slat * detail * Marks), shutter * hasShutters * home);
float trough = (f.x > 0.255 && f.x < 0.745 && f.y > 0.15 && f.y < 0.218) ? 1.0 : 0.0;
float leaves = (f.x > 0.265 && f.x < 0.735 && f.y > 0.218 && f.y < 0.243) ? 1.0 : 0.0;
float bloomAt = (f.x - 0.26) / 0.48 * 6.0;
float2 fromBloom = float2((frac(bloomAt) - 0.5) * 0.192, (f.y - 0.25) * 3.0); // metres from the nearest flower head
float bloom = (f.x > 0.26 && f.x < 0.74 && length(fromBloom) < 0.07) ? 1.0 : 0.0;
float hue = frac(floor(bloomAt) * 0.37 + own * 4.0);
float3 petal = hue < 0.34 ? float3(0.90, 0.20, 0.22) : hue < 0.67 ? float3(0.98, 0.80, 0.20) : float3(0.95, 0.50, 0.70);
c = lerp(c, float3(0.50, 0.31, 0.18), trough * hasFlowers * home);
c = lerp(c, float3(0.25, 0.55, 0.22), leaves * hasFlowers * home);
c = lerp(c, petal, bloom * hasFlowers * home);
// After dark a lamp is lit behind two windows in three (Night: 0 by day to 1 after dark, set by UEarthWeather).
float lampPick = frac(sin(bay * 12.9898 + storey * 78.233 + Span.y * 3.7) * 43758.5453);
Lamp = float3(1.0, 0.74, 0.30) * win * Win * (1.0 - bars * detail) * step(0.34, lampPick) * Night * 2.6;
WorldNormal = n;
Rough = 0.9;
return saturate(c);
)HLSL");

	/** Water: the colour, with drawn glints that drift. */
	const TCHAR* const WaterCode = TEXT(R"HLSL(
float2 p = WorldPos.xy / 100.0;
float a = sin(p.x * 0.9 + Time * 0.8) + sin((p.x + p.y) * 0.5 + Time * 0.6);
float b = sin(p.y * 1.1 - Time * 0.7) + sin((p.x - p.y) * 0.4 + Time * 0.5);
float glint = smoothstep(0.60, 0.66, (a + b) * 0.25) * (1.0 - saturate((length(WorldPos - CamPos) - 6000.0) / 9000.0));
float swell = 1.0 + 0.05 * sin(p.x * 0.13 + p.y * 0.09 + Time * 0.3) * (1.0 - Flat);
float grey = dot(Tint, float3(0.299, 0.587, 0.114));
float3 tint = max(lerp(float3(grey, grey, grey), Tint, 1.0 + Vivid), 0.0); // Vivid: the colour brighter than it was sent
WorldNormal = float3(0.0, 0.0, 1.0);
Rough = 0.7;
return saturate(lerp(tint * swell, float3(0.95, 0.98, 1.0), glint * 0.7));
)HLSL");

	/**
	 * The ink: a post-process over the whole picture. It sorts the light on every lit surface into
	 * three flat levels (shade, light, full sun), keeping the colour of the light, and draws a dark line
	 * wherever the depth, the facing or the painted colour changes sharply. Both fade out with
	 * distance, where the ordinary picture with its haze reads better than lines would.
	 *
	 * Scene colour arrives multiplied by the exposure the engine has chosen, and what is returned is
	 * multiplied by it again, so it is divided out first. The second difference of 1/depth is zero
	 * across any flat surface however steeply it is seen, so the ground does not grow lines near the horizon.
	 */
	const TCHAR* const InkCode = TEXT(R"HLSL(
const float3 Luma = float3(0.299, 0.587, 0.114);
float3 scene = SceneTextureFetch(PPI_PostProcessInput0, float2(0.0, 0.0)).rgb * View.OneOverPreExposure;
float depth = SceneTextureFetch(PPI_SceneDepth, float2(0.0, 0.0)).r;
float3 base = SceneTextureFetch(PPI_BaseColor, float2(0.0, 0.0)).rgb;
float3 facing = SceneTextureFetch(PPI_WorldNormal, float2(0.0, 0.0)).xyz;
float isLit = SceneTextureFetch(PPI_ShadingModelID, float2(0.0, 0.0)).r > 0.5 ? 1.0 : 0.0;
float haze = saturate((depth - FadeStart) / max(FadeEnd - FadeStart, 1.0));

// Light in three levels.
float lumScene = dot(scene, Luma);
float lumBase = max(dot(base, Luma), 0.02);
float light = lumScene / lumBase;
float t1 = smoothstep(Band1 * (1.0 - Soft), Band1 * (1.0 + Soft), light);
float t2 = smoothstep(Band2 * (1.0 - Soft), Band2 * (1.0 + Soft), light);
float level = lerp(lerp(Level0, Level1, t1), Level2, t2);
float3 toon = scene * (level / max(light, 1e-3));
// Plain: the surface's own colour at that level, without the colour of the light, so shade is the
// same paint darker and not blue from the sky.
toon = lerp(toon, base * level, Plain);
// After dark in the flat look, whose paint takes no notice of the light (NightDim and NightGlow, both nothing by
// day and in the other look: AEarthWalkGameMode::SetAir sets them): every surface is the same paint darker, and a
// lamp in a window, far brighter than anything the night's own light falls on, is drawn as a lamp: in the colour
// it is told (GlowR, GlowG, GlowB), which allows for the night's blue being laid over the whole picture afterwards.
toon *= 1.0 - NightDim;
// (Brighter than its paint by far, and bright in itself: a dark roof the moon catches is the first and not the second.)
toon = lerp(toon, float3(GlowR, GlowG, GlowB), NightGlow * min(smoothstep(GlowAt, GlowAt * 1.6, light), smoothstep(0.8, 1.3, lumScene)));
float3 c = lerp(scene, toon, isLit * (1.0 - haze * ToonFade));

// Lines.
// FarWidth: how wide the line still is far away, as a part of its width close by.
float w = max(1.0, InkWidth * View.ViewSizeAndInvSize.y / 720.0 * lerp(1.0, FarWidth, haze));
// Small things (tufts of grass, flowers, crops) say so with an odd, very low specular (Sheen in
// M_EarthFoliage); the sky and anything unlit has none at all. SmallInk is how much line they get: a
// line as wide as the thing itself would only blot it out.
float sheen = SceneTextureFetch(PPI_Specular, float2(0.0, 0.0)).r;
float little = (sheen > 0.008 && sheen < 0.05) ? 1.0 : 0.0;
float invDepth = 1.0 / max(depth, 1.0);
float nearest = depth;
float edge = 0.0;
for (int axis = 0; axis < 2; ++axis)
{
	float2 o = axis == 0 ? float2(w, 0.0) : float2(0.0, w);
	float d1 = SceneTextureFetch(PPI_SceneDepth, o).r;
	float d2 = SceneTextureFetch(PPI_SceneDepth, -o).r;
	float s1 = SceneTextureFetch(PPI_Specular, o).r;
	float s2 = SceneTextureFetch(PPI_Specular, -o).r;
	little = max(little, ((s1 > 0.008 && s1 < 0.05) || (s2 > 0.008 && s2 < 0.05)) ? 1.0 : 0.0);
	nearest = min(nearest, min(d1, d2));
	float bend = abs((1.0 / max(d1, 1.0) + 1.0 / max(d2, 1.0)) * 0.5 / invDepth - 1.0);
	edge = max(edge, smoothstep(DepthEdge, DepthEdge * 2.5, bend));
	float3 n1 = SceneTextureFetch(PPI_WorldNormal, o).xyz;
	float3 n2 = SceneTextureFetch(PPI_WorldNormal, -o).xyz;
	if (dot(facing, facing) > 0.25 && dot(n1, n1) > 0.25 && dot(n2, n2) > 0.25)
	{
		float turn = 1.0 - min(dot(facing, n1), dot(facing, n2));
		edge = max(edge, smoothstep(NormalEdge, NormalEdge + 0.25, turn));
	}
	float3 b1 = SceneTextureFetch(PPI_BaseColor, o).rgb;
	float3 b2 = SceneTextureFetch(PPI_BaseColor, -o).rgb;
	float paint = max(length(b1 - base), length(b2 - base));
	edge = max(edge, PaintInk * smoothstep(PaintEdge, PaintEdge * 1.6, paint) * isLit);
}
float nearFar = saturate((nearest - FadeStart) / max(FadeEnd - FadeStart, 1.0));
float ink = edge * InkStrength * lerp(1.0, InkFar, nearFar) * lerp(1.0, SmallInk, little);
// The line: the colour under it much darkened, or with InkBlack a plain black line.
return lerp(c, c * float3(0.10, 0.075, 0.085) * (1.0 - InkBlack), saturate(ink));
)HLSL");

	/** Tree canopies and trunks (instanced): the tint, varied per tree, with ruffled normals for leaves. */
	const TCHAR* const FoliageCode = TEXT(R"HLSL(
float3 p = WorldPos / 70.0;
float v = sin(p.x * 1.9 + p.y * 1.3) * sin(p.y * 1.7 + p.z * 2.1) * sin(p.z * 1.5 + p.x * 1.1);
float3 hue = lerp(float3(0.85, 1.05, 0.7), float3(1.1, 0.95, 0.75), Rand);
hue = lerp(hue, 0.5 * (hue + 1.0), Flat); // each tree still its own green, less far apart
float grey = dot(Tint, float3(0.299, 0.587, 0.114));
float3 tint = max(lerp(float3(grey, grey, grey), Tint, 1.0 + Vivid), 0.0); // Vivid: the colour brighter than it was sent
float3 c = tint * hue * lerp(0.8 + 0.3 * v, 0.95, Flat);
float3 q = WorldPos / 9.0;
float3 bump = float3(sin(q.y * 1.3 + Rand * 6.0) * sin(q.z * 0.9), sin(q.z * 1.1 + Rand * 3.0) * sin(q.x * 0.8), sin(q.x * 1.2 + Rand) * sin(q.y * 0.7));
WorldNormal = normalize(normalize(Normal) + Fluff * 0.35 * bump * (1.0 - Flat));
Rough = 0.95;
return saturate(c);
)HLSL");

	/**
	 * Wind: everything drawn with the foliage material leans to and fro together, in gusts that travel
	 * across the land, by up to Sway centimetres. The foot of each shape stays put and its top moves
	 * most (the engine's basic shapes run from -50 to 50 in their own space), so a tuft bends rather
	 * than slides.
	 */
	const TCHAR* const SwayCode = TEXT(R"HLSL(
float phase = Time * 1.7 + WorldPos.x * 0.0045 + WorldPos.y * 0.0033;
float gust = sin(phase) + 0.45 * sin(phase * 2.3 + 1.7);
float lift = saturate(0.5 + Local.z / 100.0);
// Wind: which way it blows (a step of one along the ground). Gale: how hard, against a fine day's breeze (UEarthWeather sets both).
return float3(Wind.x, Wind.y, 0.0) * gust * Sway * Gale * lift * lift;
)HLSL");

	/**
	 * The sky, painted on the inside of a great ball round the player (AEarthSky): pale at the horizon
	 * and deep overhead, a drawn sun, and rows of flat-bottomed clouds with an inked edge and a shaded
	 * underside, drifting slowly. The clouds are laid out like a painted backdrop, by compass bearing
	 * and height above the horizon, in three rows: small and far near the horizon, big higher up. Each
	 * row is a ring of places round the sky; a place holds a cloud or not, and a cloud is five puffs
	 * side by side, cut flat along the bottom.
	 */
	const TCHAR* const SkyCode = TEXT(R"HLSL(
float3 d = normalize(-ToCamera);
float3 sunDir = normalize(Sun);
float3 moonDir = normalize(Moon);
float el = asin(clamp(d.z, -1.0, 1.0));
float az = atan2(d.y, d.x);
float up = saturate(d.z);

// The air: pale by the horizon, deep overhead, a little warm round the sun. (Colours here are
// amounts of light, not screen colours, so they look darker written down than they come out.)
// What they are at this hour and in this weather comes from EarthSkyMath (skyLight in skymath.js).
float3 c = lerp(Horizon, Mid, smoothstep(0.0, 0.34, up));
c = lerp(c, Zenith, smoothstep(0.25, 0.95, up));
float toSun = dot(d, sunDir);
c += Glow * pow(saturate(toSun), 8.0) * (1.0 - Flat);
// Morning and evening: warm light low along the horizon, strongest under the sun.
float2 dLevel = normalize(d.xy + float2(0.00001, 0.00001));
float2 sunLevel = normalize(sunDir.xy + float2(0.00001, 0.00001));
float sunSide = 0.5 + 0.5 * dot(dLevel, sunLevel);
c += Dusk * (1.0 - smoothstep(0.0, 0.32, up)) * (0.2 + 0.8 * sunSide * sunSide) * (1.0 - Flat);
// Below the horizon, where the land has run out: far country in haze.
c = lerp(c, float3(0.40, 0.66, 0.66) * Land, 1.0 - smoothstep(-0.09, -0.01, d.z));
c = lerp(c, float3(0.26, 0.52, 0.34) * Land, 1.0 - smoothstep(-0.5, -0.09, d.z));
// The flat look: one colour from the horizon up.
c = lerp(c, FlatSky, Flat * smoothstep(-0.02, 0.0, d.z));
c *= Bright;
// Nothing in the sky shows through the land.
float above = smoothstep(-0.02, -0.005, d.z);
float aa = 0.0014;

// Stars: the sky is cut into small boxes, and one box in ten holds a star, each with its own size and twinkle.
if (Stars > 0.0 && d.z > 0.0)
{
	float3 q = d * 34.0;
	float3 cell = floor(q);
	float h = frac(sin(dot(cell, float3(127.1, 311.7, 74.7))) * 43758.5453);
	if (h > 0.90)
	{
		float3 jitter = float3(frac(sin(h * 91.7) * 43758.5453), frac(sin(h * 47.3) * 43758.5453), frac(sin(h * 13.9) * 43758.5453));
		float3 middle = cell + 0.5 + (jitter - 0.5) * 0.5;
		float size = 0.07 + 0.19 * frac(sin(h * 7.7) * 43758.5453) * frac(sin(h * 5.3) * 43758.5453);
		float twinkle = 0.78 + 0.22 * sin(Time * (1.0 + 2.5 * frac(sin(h * 3.1) * 43758.5453)) + h * 500.0);
		float star = (1.0 - smoothstep(size * 0.55, size, length(q - middle))) * twinkle;
		c = lerp(c, float3(1.0, 0.96, 0.82) * CloudBright, star * Stars * smoothstep(0.0, 0.10, d.z));
	}
}

// The sun: a warm disc with a drawn edge and a pale ring of glow.
float sunAngle = acos(clamp(toSun, -1.0, 1.0));
float glow = exp(-sunAngle * 9.0);
float sunSeen = SunShow * above;
c = lerp(c, float3(1.0, 0.92, 0.60) * SunDisc * CloudBright, glow * 0.35 * (1.0 - Flat) * sunSeen);
float rim = 1.0 - smoothstep(SunSize + 0.006 - aa, SunSize + 0.006 + aa, sunAngle);
float disc = 1.0 - smoothstep(SunSize - aa, SunSize + aa, sunAngle);
c = lerp(c, float3(1.0, 0.42, 0.04) * SunDisc * CloudBright, rim * sunSeen);
c = lerp(c, float3(1.0, 0.80, 0.22) * SunDisc * CloudBright * 1.3, disc * sunSeen);

// The moon: a ball lit from where the sun really is, so its phase and the way its horns point are the real ones.
if (MoonShow > 0.0)
{
	float moonAngle = acos(clamp(dot(d, moonDir), -1.0, 1.0));
	float moonSeen = MoonShow * above;
	c = lerp(c, float3(0.70, 0.82, 1.0) * CloudBright, exp(-moonAngle * 10.0) * 0.32 * MoonGlow * (1.0 - Flat) * above);
	if (moonAngle < MoonSize + 0.02)
	{
		float3 mx = normalize(cross(float3(0.0, 0.0, 1.0), moonDir) + float3(0.0001, 0.0, 0.0));
		float3 my = cross(moonDir, mx);
		float2 mq = float2(dot(d, mx), dot(d, my)) / sin(MoonSize);
		float mr = length(mq);
		float3 facing = mq.x * mx + mq.y * my - sqrt(max(0.0, 1.0 - mr * mr)) * moonDir;
		float sunlit = smoothstep(-0.04, 0.04, dot(facing, sunDir));
		// Three grey seas, drawn as plain rounds.
		float seas = max(max(1.0 - smoothstep(0.24, 0.27, length(mq - float2(-0.30, 0.28))), 1.0 - smoothstep(0.16, 0.19, length(mq - float2(0.28, -0.12)))), 1.0 - smoothstep(0.11, 0.14, length(mq - float2(0.02, -0.52))));
		float3 pale = float3(0.98, 0.95, 0.80) * (1.0 - 0.17 * seas) * CloudBright;
		float3 moonFace = lerp(lerp(c, pale, 0.08), pale, sunlit);
		float moonSoft = aa / MoonSize;
		float moonRim = 1.0 - smoothstep(1.0 + 0.10 - moonSoft, 1.0 + 0.10 + moonSoft, mr);
		float moonDisc = 1.0 - smoothstep(1.0 - moonSoft, 1.0 + moonSoft, mr);
		c = lerp(c, lerp(float3(0.30, 0.38, 0.62), float3(0.01, 0.012, 0.02), Flat) * CloudBright, moonRim * moonSeen * 0.55);
		c = lerp(c, moonFace, moonDisc * moonSeen);
	}
}

// Clouds. (DriftAt is how much further round the wind has carried them than a fine day's breeze would.)
float inkLight = clamp(dot(CloudLit, float3(0.299, 0.587, 0.114)), 0.3, 1.0);
for (int row = 0; row < 3; ++row)
{
	float rowEl = row == 0 ? 0.11 : row == 1 ? 0.27 : 0.50;
	float puff = row == 0 ? 0.040 : row == 1 ? 0.064 : 0.098;
	float places = row == 0 ? 15.0 : row == 1 ? 10.0 : 7.0;
	float around = cos(rowEl);
	float placeWidth = 6.2831853 / places;
	float a = az + (Time * Drift + DriftAt) * (0.6 + 0.5 * row) + row * 1.7;
	float place = floor(a / placeWidth);
	for (int k = -1; k <= 1; ++k)
	{
		float id = place + k;
		float own = id - places * floor(id / places) + row * 31.0;
		float r1 = frac(sin(own * 127.1 + 3.7) * 43758.5453);
		float r2 = frac(sin(own * 269.5 + 1.3) * 43758.5453);
		float r3 = frac(sin(own * 419.2 + 7.1) * 43758.5453);
		if (r1 > Clouds)
		{
			continue;
		}
		float s = puff * (0.75 + 0.6 * r2);
		float middle = (id + 0.5 + (r3 - 0.5) * 0.45) * placeWidth;
		float2 p = float2((a - middle) * around, el - (rowEl + (r2 - 0.5) * 0.07)) / s;
		if (abs(p.x) > 3.2 || p.y > 2.6 || p.y < -0.3)
		{
			continue;
		}
		float shape = 1000.0;
		for (int j = 0; j < 5; ++j)
		{
			float fj = j;
			float rj = frac(sin((own * 17.0 + fj * 53.0) * 12.9898) * 43758.5453);
			float big = (1.0 - abs(fj - 2.0) * 0.21) * (0.72 + 0.42 * rj);
			float2 at = float2((fj - 2.0) * 0.64 + (rj - 0.5) * 0.2, big * 0.52);
			shape = min(shape, length(p - at) - big);
		}
		// Sunlit above, shaded in a wavy band along the flat bottom.
		float underside = 0.34 + 0.09 * sin(p.x * 4.3 + own * 2.1) + 0.05 * sin(p.x * 9.1 + own);
		float edge = max(shape, -p.y);
		float soft = aa / s;
		float inside = 1.0 - smoothstep(-soft, soft, edge);
		float lineWidth = CloudInk * 0.0032 / s;
		float inked = smoothstep(-lineWidth - soft, -lineWidth + soft, edge);
		float shaded = (1.0 - smoothstep(underside - 0.03, underside + 0.03, p.y)) * (1.0 - 0.75 * Flat);
		float3 cloud = lerp(CloudLit, CloudShade, shaded) * CloudBright;
		cloud = lerp(cloud, lerp(float3(0.05, 0.13, 0.38) * inkLight, float3(0.01, 0.012, 0.02), Flat), inked * step(0.001, CloudInk));
		// Far clouds sink into the air by the horizon.
		cloud = lerp(cloud, c, (row == 0 ? 0.30 : row == 1 ? 0.10 : 0.0) * (1.0 - Flat));
		c = lerp(c, cloud, inside);
	}
}
// Fog and falling rain: the sky is lost in it.
c = lerp(c, MistColour * Bright, Mist);
return c;
)HLSL");

	/**
	 * Picket fences. The server sends a fence as a row of thin upright boxes; this cuts each face into
	 * pales with pointed tops and gaps between them, on two rails. Below.x is metres below the top of
	 * the fence and Below.y is 1 on an upright face (AEarthWorld::BuildChunk works them out). The pales
	 * are placed by where they stand in the world, so the two faces of a fence line up. Far away the
	 * gaps close and are drawn as lines instead, where they would only flicker.
	 */
	const TCHAR* const FenceCode = TEXT(R"HLSL(
float3 n = normalize(Normal);
float2 across = normalize(n.xy + float2(1e-4, 0.0));
float along = dot(WorldPos.xy / 100.0, float2(across.y, -across.x));
float below = Below.x;
float fromMiddle = abs(frac(along / 0.2) - 0.5);
float pale = fromMiddle < 0.32 ? 1.0 : 0.0;
float tip = step(fromMiddle * 0.42 + 0.01, below);
float rail = (abs(below - 0.30) < 0.045 || abs(below - 0.70) < 0.045) ? 1.0 : 0.0;
float away = saturate((length(WorldPos - CamPos) - 2500.0) / 1500.0);
float upClose = max(pale * tip, rail * (1.0 - pale));
Mask = lerp(upClose, tip, away) * Below.y;
float3 c = Tint;
c *= 1.0 - 0.14 * rail * (1.0 - pale);
c *= 1.0 - 0.10 * smoothstep(0.22, 0.32, fromMiddle) * pale;
c *= 1.0 - 0.30 * (1.0 - pale) * away;
WorldNormal = n;
Rough = 0.9;
return saturate(c);
)HLSL");

	bool SaveAsset(UObject* Asset)
	{
		UPackage* Package = Asset->GetOutermost();
		Package->MarkPackageDirty();
		const FString FileName = FPackageName::LongPackageNameToFilename(Package->GetName(), FPackageName::GetAssetPackageExtension());
		FSavePackageArgs Args;
		Args.TopLevelFlags = RF_Public | RF_Standalone;
		Args.SaveFlags = SAVE_NoError;
		const bool bSaved = UPackage::SavePackage(Package, Asset, *FileName, Args);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("%s %s"), bSaved ? TEXT("Saved") : TEXT("FAILED to save"), *Package->GetName());
		return bSaved;
	}

	UMaterial* FreshMaterial(IAssetTools& Tools, const FString& Name)
	{
		const FString ObjectPath = FString::Printf(TEXT("%s/%s.%s"), MaterialPath, *Name, *Name);
		if (UMaterial* Existing = LoadObject<UMaterial>(nullptr, *ObjectPath))
		{
			// A material one of the game's classes loads as it is set up (AEarthLife loads M_EarthFigure
			// in its constructor) is kept by the engine for good, and cannot be taken apart here: it is
			// left as it is. To change such a material, delete its .uasset first and run this again.
			for (const TObjectPtr<UMaterialExpression>& Expression : Existing->GetExpressions())
			{
				if (Expression && Expression->IsRooted())
				{
					UE_LOG(LogEarthWalkAssets, Display, TEXT("Left %s as it is: the game holds it loaded. Delete its .uasset to rebuild it."), *Name);
					return nullptr;
				}
			}
			UMaterialEditingLibrary::DeleteAllMaterialExpressions(Existing);
			return Existing;
		}
		UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
		return Cast<UMaterial>(Tools.CreateAsset(Name, MaterialPath, UMaterial::StaticClass(), Factory));
	}

	template <class T>
	T* Node(UMaterial* Material, int32 X, int32 Y)
	{
		return Cast<T>(UMaterialEditingLibrary::CreateMaterialExpression(Material, T::StaticClass(), X, Y));
	}

	UMaterialExpressionScalarParameter* Scalar(UMaterial* Material, const TCHAR* Name, float Default, int32 Y)
	{
		UMaterialExpressionScalarParameter* Param = Node<UMaterialExpressionScalarParameter>(Material, -900, Y);
		Param->ParameterName = Name;
		Param->DefaultValue = Default;
		return Param;
	}

	/** One Custom HLSL node drives base colour, roughness and the world-space normal. */
	UMaterialExpressionCustom* CustomNode(UMaterial* Material, const TCHAR* Code, const TArray<FName>& InputNames)
	{
		UMaterialExpressionCustom* Custom = Node<UMaterialExpressionCustom>(Material, -300, 0);
		Custom->Code = Code;
		Custom->Description = TEXT("EarthWalk");
		Custom->OutputType = CMOT_Float3;
		Custom->Inputs.Reset();
		for (const FName& Name : InputNames)
		{
			FCustomInput Input;
			Input.InputName = Name;
			Custom->Inputs.Add(Input);
		}
		FCustomOutput Rough;
		Rough.OutputName = TEXT("Rough");
		Rough.OutputType = CMOT_Float1;
		Custom->AdditionalOutputs.Add(Rough);
		FCustomOutput Normal;
		Normal.OutputName = TEXT("WorldNormal");
		Normal.OutputType = CMOT_Float3;
		Custom->AdditionalOutputs.Add(Normal);
		Custom->RebuildOutputs();
		return Custom;
	}

	void Connect(UMaterialExpression* From, UMaterialExpressionCustom* Custom, const TCHAR* InputName)
	{
		if (!UMaterialEditingLibrary::ConnectMaterialExpressions(From, TEXT(""), Custom, InputName))
		{
			UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not connect %s"), InputName);
		}
	}

	/** The dials of the look, as the barnyard look has them; the game turns them for the flat look (EarthLook.cpp). */
	void ConnectLook(UMaterial* Material, UMaterialExpressionCustom* Custom, bool bMarks)
	{
		Connect(Scalar(Material, TEXT("Flat"), 0.f, 1000), Custom, TEXT("Flat"));
		Connect(Scalar(Material, TEXT("Vivid"), 0.f, 1090), Custom, TEXT("Vivid"));
		if (bMarks)
		{
			Connect(Scalar(Material, TEXT("Marks"), 1.f, 1180), Custom, TEXT("Marks"));
		}
	}

	void FinishMaterial(UMaterial* Material, UMaterialExpressionCustom* Custom)
	{
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT("Rough"), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT("WorldNormal"), MP_Normal);
		Material->bTangentSpaceNormal = false;
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}

	void BuildPaintedMaterial(IAssetTools& Tools, const FString& Name, const TCHAR* Code, bool bWall)
	{
		UMaterial* Material = FreshMaterial(Tools, Name);
		if (!Material)
		{
			UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not create material %s"), *Name);
			return;
		}
		TArray<FName> Inputs = { TEXT("WorldPos"), TEXT("Normal"), TEXT("CamPos"), TEXT("Tint"), TEXT("Flat"), TEXT("Vivid"), TEXT("Marks") };
		if (bWall)
		{
			Inputs.Add(TEXT("Windows"));
			Inputs.Add(TEXT("Bricks"));
			Inputs.Add(TEXT("Homely"));
			Inputs.Add(TEXT("RowShift"));
			Inputs.Add(TEXT("Span"));
			Inputs.Add(TEXT("Night"));
		}
		else
		{
			Inputs.Add(TEXT("Pattern"));
		}
		UMaterialExpressionCustom* Custom = CustomNode(Material, Code, Inputs);
		if (bWall)
		{
			// The light of lamps behind the windows after dark: it shines of itself, whatever lights the wall.
			FCustomOutput Lamp;
			Lamp.OutputName = TEXT("Lamp");
			Lamp.OutputType = CMOT_Float3;
			Custom->AdditionalOutputs.Add(Lamp);
			Custom->RebuildOutputs();
		}

		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor::White;

		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -450), Custom, TEXT("WorldPos"));
		Connect(Node<UMaterialExpressionVertexNormalWS>(Material, -900, -300), Custom, TEXT("Normal"));
		Connect(Node<UMaterialExpressionCameraPositionWS>(Material, -900, -150), Custom, TEXT("CamPos"));
		Connect(Tint, Custom, TEXT("Tint"));
		ConnectLook(Material, Custom, true);
		if (bWall)
		{
			Connect(Scalar(Material, TEXT("Windows"), 1.f, 150), Custom, TEXT("Windows"));
			Connect(Scalar(Material, TEXT("Bricks"), 0.f, 250), Custom, TEXT("Bricks"));
			Connect(Scalar(Material, TEXT("Homely"), 0.f, 300), Custom, TEXT("Homely"));
			Connect(Node<UMaterialExpressionTextureCoordinate>(Material, -900, 350), Custom, TEXT("RowShift"));
			UMaterialExpressionTextureCoordinate* Span = Node<UMaterialExpressionTextureCoordinate>(Material, -900, 450);
			Span->CoordinateIndex = 1;
			Connect(Span, Custom, TEXT("Span"));
			Connect(Scalar(Material, TEXT("Night"), 0.f, 550), Custom, TEXT("Night"));
			UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT("Lamp"), MP_EmissiveColor);
		}
		else
		{
			Connect(Scalar(Material, TEXT("Pattern"), 0.f, 150), Custom, TEXT("Pattern"));
		}
		FinishMaterial(Material, Custom);
	}

	/** The outline and flat-light pass (InkCode), applied to the whole view by AEarthWalkGameMode. */
	void BuildInkMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthInk"));
		if (!Material)
		{
			return;
		}
		Material->MaterialDomain = MD_PostProcess;
		// Before the engine's anti-aliasing, so the lines are smoothed with everything else, and before
		// the tone curve, so the flat levels of light are still light and not screen colours.
		Material->BlendableLocation = BL_SceneColorAfterDOF;

		UMaterialExpressionCustom* Custom = Node<UMaterialExpressionCustom>(Material, -300, 0);
		Custom->Code = InkCode;
		Custom->Description = TEXT("EarthWalk ink");
		Custom->OutputType = CMOT_Float3;
		Custom->Inputs.Reset();

		// The code reads the scene itself; these nodes only tell the material which parts of it are needed.
		struct FUse { const TCHAR* Key; ESceneTextureId Value; };
		struct FSetting { const TCHAR* Key; float Value; };
		const FUse Scene[] = {
			{ TEXT("UseColour"), PPI_PostProcessInput0 }, { TEXT("UseDepth"), PPI_SceneDepth }, { TEXT("UseBase"), PPI_BaseColor },
			{ TEXT("UseNormal"), PPI_WorldNormal }, { TEXT("UseModel"), PPI_ShadingModelID }, { TEXT("UseSheen"), PPI_Specular },
		};
		// Defaults found by eye at Titirangi and Queens Wharf; AEarthWalkGameMode can override any of them
		// from the InkTuning setting without rebuilding this asset.
		const FSetting Settings[] = {
			{ TEXT("InkWidth"), 1.3f }, { TEXT("InkStrength"), 0.9f }, { TEXT("InkFar"), 0.25f },
			{ TEXT("DepthEdge"), 0.02f }, { TEXT("NormalEdge"), 0.35f }, { TEXT("PaintEdge"), 0.2f }, { TEXT("PaintInk"), 0.6f },
			{ TEXT("Band1"), 0.9f }, { TEXT("Band2"), 2.2f }, { TEXT("Soft"), 0.06f },
			{ TEXT("Level0"), 0.68f }, { TEXT("Level1"), 1.4f }, { TEXT("Level2"), 1.65f },
			{ TEXT("FadeStart"), 12000.f }, { TEXT("FadeEnd"), 60000.f }, { TEXT("ToonFade"), 1.f }, { TEXT("InkBlack"), 0.f }, { TEXT("Plain"), 0.f },
			{ TEXT("FarWidth"), 1.f }, { TEXT("SmallInk"), 1.f },
			{ TEXT("NightDim"), 0.f }, { TEXT("NightGlow"), 0.f }, { TEXT("GlowAt"), 1.6f }, { TEXT("GlowR"), 1.f }, { TEXT("GlowG"), 0.74f }, { TEXT("GlowB"), 0.3f },
		};
		for (const FUse& Use : Scene)
		{
			FCustomInput Input;
			Input.InputName = Use.Key;
			Custom->Inputs.Add(Input);
		}
		for (const FSetting& Setting : Settings)
		{
			FCustomInput Input;
			Input.InputName = Setting.Key;
			Custom->Inputs.Add(Input);
		}
		Custom->RebuildOutputs();

		int32 Y = -600;
		for (const FUse& Use : Scene)
		{
			UMaterialExpressionSceneTexture* Texture = Node<UMaterialExpressionSceneTexture>(Material, -900, Y += 120);
			Texture->SceneTextureId = Use.Value;
			if (!UMaterialEditingLibrary::ConnectMaterialExpressions(Texture, TEXT("Color"), Custom, Use.Key))
			{
				UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not connect %s"), Use.Key);
			}
		}
		for (const FSetting& Setting : Settings)
		{
			Connect(Scalar(Material, Setting.Key, Setting.Value, Y += 90), Custom, Setting.Key);
		}
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT(""), MP_EmissiveColor);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}

	void BuildFoliageMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthFoliage"));
		if (!Material)
		{
			return;
		}
		UMaterialExpressionCustom* Custom = CustomNode(Material, FoliageCode, { TEXT("WorldPos"), TEXT("Normal"), TEXT("Tint"), TEXT("Rand"), TEXT("Fluff"), TEXT("Flat"), TEXT("Vivid") });
		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor(0.2f, 0.5f, 0.18f);
		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -300), Custom, TEXT("WorldPos"));
		Connect(Node<UMaterialExpressionVertexNormalWS>(Material, -900, -150), Custom, TEXT("Normal"));
		Connect(Tint, Custom, TEXT("Tint"));
		Connect(Node<UMaterialExpressionPerInstanceRandom>(Material, -900, 150), Custom, TEXT("Rand"));
		Connect(Scalar(Material, TEXT("Fluff"), 1.f, 300), Custom, TEXT("Fluff"));
		ConnectLook(Material, Custom, false);
		// Leaves and bark are matt: almost no specular highlight. Small ground cover is given 0.02, which
		// looks the same and tells the ink to go easy on it (InkCode).
		UMaterialEditingLibrary::ConnectMaterialProperty(Scalar(Material, TEXT("Sheen"), 0.08f, 400), TEXT(""), MP_Specular);
		// Wind, as a second small node moving the vertices.
		UMaterialExpressionCustom* Wind = Node<UMaterialExpressionCustom>(Material, -300, 700);
		Wind->Code = SwayCode;
		Wind->Description = TEXT("EarthWalk wind");
		Wind->OutputType = CMOT_Float3;
		Wind->Inputs.Reset();
		for (const TCHAR* Name : { TEXT("WorldPos"), TEXT("Local"), TEXT("Time"), TEXT("Sway"), TEXT("Wind"), TEXT("Gale") })
		{
			FCustomInput Input;
			Input.InputName = Name;
			Wind->Inputs.Add(Input);
		}
		Wind->RebuildOutputs();
		// Positions before any offset: the offset cannot depend on itself.
		UMaterialExpressionWorldPosition* Still = Node<UMaterialExpressionWorldPosition>(Material, -900, 600);
		Still->WorldPositionShaderOffset = WPT_ExcludeAllShaderOffsets;
		UMaterialExpressionLocalPosition* Local = Node<UMaterialExpressionLocalPosition>(Material, -900, 700);
		Local->IncludedOffsets = EPositionIncludedOffsets::ExcludeOffsets;
		Local->LocalOrigin = ELocalPositionOrigin::Instance;
		Connect(Still, Wind, TEXT("WorldPos"));
		Connect(Local, Wind, TEXT("Local"));
		Connect(Node<UMaterialExpressionTime>(Material, -900, 800), Wind, TEXT("Time"));
		Connect(Scalar(Material, TEXT("Sway"), 0.f, 900), Wind, TEXT("Sway"));
		UMaterialExpressionVectorParameter* Blows = Node<UMaterialExpressionVectorParameter>(Material, -900, 1000);
		Blows->ParameterName = TEXT("Wind");
		Blows->DefaultValue = FLinearColor(0.8f, 0.6f, 0.f); // as it always blew, until the weather says
		Connect(Blows, Wind, TEXT("Wind"));
		Connect(Scalar(Material, TEXT("Gale"), 1.f, 1150), Wind, TEXT("Gale"));
		UMaterialEditingLibrary::ConnectMaterialProperty(Wind, TEXT(""), MP_WorldPositionOffset);
		Material->bUsedWithInstancedStaticMeshes = true;
		FinishMaterial(Material, Custom);
	}

	/**
	 * Animals, cars and trains (AEarthLife): thousands of the engine's basic shapes drawn as a few
	 * instanced meshes, each shape painted the flat colour it carries with it (three numbers per
	 * instance), matt like the leaves.
	 */
	void BuildFigureMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthFigure"));
		if (!Material)
		{
			return;
		}
		UMaterialExpressionPerInstanceCustomData3Vector* Paint = Node<UMaterialExpressionPerInstanceCustomData3Vector>(Material, -600, 0);
		Paint->DataIndex = 0;
		Paint->ConstDefaultValue = FLinearColor::White;
		UMaterialExpressionConstant* Rough = Node<UMaterialExpressionConstant>(Material, -600, 200);
		Rough->R = 0.9f;
		UMaterialExpressionConstant* Matt = Node<UMaterialExpressionConstant>(Material, -600, 300);
		Matt->R = 0.1f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Paint, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Rough, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Matt, TEXT(""), MP_Specular);
		Material->bUsedWithInstancedStaticMeshes = true;
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}

	/**
	 * Ready-made models (EarthModels.h, a trial): each corner of the mesh carries its own colour, and
	 * where its alpha is 1 the car's own paint goes instead (three numbers per instance, as for the
	 * figures). Gamma undoes the picture-style (sRGB) keeping of corner colours.
	 */
	void BuildModelMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthModel"));
		if (!Material)
		{
			return;
		}
		UMaterialExpressionCustom* Custom = Node<UMaterialExpressionCustom>(Material, -300, 0);
		Custom->Code = TEXT("return lerp(pow(max(Corner, 0.0), Gamma), Paint, saturate(Own));");
		Custom->Description = TEXT("EarthWalk model");
		Custom->OutputType = CMOT_Float3;
		Custom->Inputs.Reset();
		for (const TCHAR* Name : { TEXT("Corner"), TEXT("Own"), TEXT("Paint"), TEXT("Gamma") })
		{
			FCustomInput Input;
			Input.InputName = Name;
			Custom->Inputs.Add(Input);
		}
		Custom->RebuildOutputs();
		UMaterialExpressionVertexColor* Corner = Node<UMaterialExpressionVertexColor>(Material, -900, -200);
		UMaterialExpressionPerInstanceCustomData3Vector* Paint = Node<UMaterialExpressionPerInstanceCustomData3Vector>(Material, -900, 0);
		Paint->DataIndex = 0;
		Paint->ConstDefaultValue = FLinearColor::White;
		Connect(Corner, Custom, TEXT("Corner"));
		if (!UMaterialEditingLibrary::ConnectMaterialExpressions(Corner, TEXT("A"), Custom, TEXT("Own")))
		{
			UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not connect the corner's alpha in M_EarthModel"));
		}
		Connect(Paint, Custom, TEXT("Paint"));
		Connect(Scalar(Material, TEXT("Gamma"), 2.2f, 200), Custom, TEXT("Gamma"));
		UMaterialExpressionConstant* Rough = Node<UMaterialExpressionConstant>(Material, -600, 400);
		Rough->R = 0.9f;
		UMaterialExpressionConstant* Matt = Node<UMaterialExpressionConstant>(Material, -600, 500);
		Matt->R = 0.1f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Rough, TEXT(""), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Matt, TEXT(""), MP_Specular);
		Material->bUsedWithInstancedStaticMeshes = true;
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}

	void BuildWaterMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthWater"));
		if (!Material)
		{
			return;
		}
		UMaterialExpressionCustom* Custom = CustomNode(Material, WaterCode, { TEXT("WorldPos"), TEXT("CamPos"), TEXT("Tint"), TEXT("Time"), TEXT("Flat"), TEXT("Vivid") });
		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor(0.25f, 0.5f, 0.71f);
		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -300), Custom, TEXT("WorldPos"));
		Connect(Node<UMaterialExpressionCameraPositionWS>(Material, -900, -150), Custom, TEXT("CamPos"));
		Connect(Tint, Custom, TEXT("Tint"));
		Connect(Node<UMaterialExpressionTime>(Material, -900, 150), Custom, TEXT("Time"));
		ConnectLook(Material, Custom, false);
		FinishMaterial(Material, Custom);
	}
}

namespace
{
	/** Picket fences (FenceCode): painted like the other surfaces, with holes cut in it. */
	void BuildFenceMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthFence"));
		if (!Material)
		{
			return;
		}
		Material->BlendMode = BLEND_Masked;
		UMaterialExpressionCustom* Custom = CustomNode(Material, FenceCode, { TEXT("WorldPos"), TEXT("Normal"), TEXT("CamPos"), TEXT("Tint"), TEXT("Below") });
		FCustomOutput Mask;
		Mask.OutputName = TEXT("Mask");
		Mask.OutputType = CMOT_Float1;
		Custom->AdditionalOutputs.Add(Mask);
		Custom->RebuildOutputs();
		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor::White;
		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -450), Custom, TEXT("WorldPos"));
		Connect(Node<UMaterialExpressionVertexNormalWS>(Material, -900, -300), Custom, TEXT("Normal"));
		Connect(Node<UMaterialExpressionCameraPositionWS>(Material, -900, -150), Custom, TEXT("CamPos"));
		Connect(Tint, Custom, TEXT("Tint"));
		Connect(Node<UMaterialExpressionTextureCoordinate>(Material, -900, 150), Custom, TEXT("Below"));
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT("Mask"), MP_OpacityMask);
		FinishMaterial(Material, Custom);
	}

	/**
	 * What falls (UEarthWeather): rain, snow and blown leaves, each a small plain shape in one colour. Unlit and
	 * see-through, so it is drawn after the ink line has been found and gets none, as in the browser game.
	 */
	void BuildFallMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthFall"));
		if (!Material)
		{
			return;
		}
		Material->SetShadingModel(MSM_Unlit);
		Material->BlendMode = BLEND_Translucent;
		Material->TwoSided = true;
		Material->bUsedWithInstancedStaticMeshes = true;
		UMaterialExpressionVectorParameter* Colour = Node<UMaterialExpressionVectorParameter>(Material, -500, 0);
		Colour->ParameterName = TEXT("Color");
		Colour->DefaultValue = FLinearColor(0.62f, 0.74f, 0.92f);
		UMaterialEditingLibrary::ConnectMaterialProperty(Colour, TEXT(""), MP_EmissiveColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Scalar(Material, TEXT("Opacity"), 0.9f, 200), TEXT(""), MP_Opacity);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}

	/** The painted sky (SkyCode): unlit, seen from inside, and marked as sky so the engine lights the world from it. */
	void BuildSkyMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthSky"));
		if (!Material)
		{
			return;
		}
		Material->SetShadingModel(MSM_Unlit);
		Material->TwoSided = true;
		Material->bIsSky = true;

		UMaterialExpressionCustom* Custom = Node<UMaterialExpressionCustom>(Material, -300, 0);
		Custom->Code = SkyCode;
		Custom->Description = TEXT("EarthWalk sky");
		Custom->OutputType = CMOT_Float3;
		Custom->Inputs.Reset();
		struct FSetting { const TCHAR* Key; float Value; };
		// Bright: how light the air is beside the sunlit ground, and CloudBright the clouds and sun. Clouds: how many of the places
		// hold a cloud (0 none, 1 all). Drift: how fast they go round, radians a second. SunSize: radians.
		// Flat: the flat look's sky, one blue with plain white clouds.
		const FSetting Settings[] = {
			{ TEXT("Bright"), 0.9f }, { TEXT("CloudBright"), 1.5f }, { TEXT("Clouds"), 0.66f }, { TEXT("CloudInk"), 1.f }, { TEXT("Drift"), 0.0025f }, { TEXT("SunSize"), 0.05f }, { TEXT("Flat"), 0.f },
			// The hour and the weather (UEarthWeather sets them; as built, a fine day): how strongly the sun, the stars and the moon are drawn,
			// the moon's glow and size (radians), how lost in mist the sky is, and how much further round the wind has carried the clouds.
			{ TEXT("SunShow"), 1.f }, { TEXT("Stars"), 0.f }, { TEXT("MoonShow"), 0.f }, { TEXT("MoonGlow"), 0.f }, { TEXT("MoonSize"), 0.045f }, { TEXT("Mist"), 0.f }, { TEXT("DriftAt"), 0.f },
		};
		// The colours of the hour (EarthSkyMath::Light): as built, a fine day's.
		struct FColour { const TCHAR* Key; FLinearColor Value; };
		const FColour Colours[] = {
			{ TEXT("Moon"), FLinearColor(0.f, 0.f, 1.f) },
			{ TEXT("Zenith"), FLinearColor(0.025f, 0.15f, 0.70f) }, { TEXT("Mid"), FLinearColor(0.10f, 0.36f, 0.86f) }, { TEXT("Horizon"), FLinearColor(0.42f, 0.70f, 0.95f) },
			{ TEXT("FlatSky"), FLinearColor(0.09f, 0.40f, 1.0f) }, { TEXT("Glow"), FLinearColor(0.10f, 0.08f, 0.02f) }, { TEXT("Dusk"), FLinearColor(0.f, 0.f, 0.f) },
			{ TEXT("Land"), FLinearColor(1.f, 1.f, 1.f) }, { TEXT("SunDisc"), FLinearColor(1.f, 1.f, 1.f) },
			{ TEXT("CloudLit"), FLinearColor(1.0f, 1.0f, 0.985f) }, { TEXT("CloudShade"), FLinearColor(0.56f, 0.69f, 0.93f) }, { TEXT("MistColour"), FLinearColor(0.74f, 0.78f, 0.80f) },
		};
		for (const TCHAR* Name : { TEXT("ToCamera"), TEXT("Sun"), TEXT("Time") })
		{
			FCustomInput Input;
			Input.InputName = Name;
			Custom->Inputs.Add(Input);
		}
		for (const FColour& Colour : Colours)
		{
			FCustomInput Input;
			Input.InputName = Colour.Key;
			Custom->Inputs.Add(Input);
		}
		for (const FSetting& Setting : Settings)
		{
			FCustomInput Input;
			Input.InputName = Setting.Key;
			Custom->Inputs.Add(Input);
		}
		Custom->RebuildOutputs();

		// Where the sun stands, as the way to it (AEarthSky sets it from the sun's light).
		UMaterialExpressionVectorParameter* Sun = Node<UMaterialExpressionVectorParameter>(Material, -900, -150);
		Sun->ParameterName = TEXT("Sun");
		Sun->DefaultValue = FLinearColor(0.572f, -0.572f, 0.588f);
		Connect(Node<UMaterialExpressionCameraVectorWS>(Material, -900, -300), Custom, TEXT("ToCamera"));
		Connect(Sun, Custom, TEXT("Sun"));
		Connect(Node<UMaterialExpressionTime>(Material, -900, 0), Custom, TEXT("Time"));
		int32 Y = 60;
		for (const FSetting& Setting : Settings)
		{
			Connect(Scalar(Material, Setting.Key, Setting.Value, Y += 90), Custom, Setting.Key);
		}
		int32 ColourY = -450;
		for (const FColour& Colour : Colours)
		{
			UMaterialExpressionVectorParameter* Param = Node<UMaterialExpressionVectorParameter>(Material, -1300, ColourY += 160);
			Param->ParameterName = Colour.Key;
			Param->DefaultValue = Colour.Value;
			Connect(Param, Custom, Colour.Key);
		}
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT(""), MP_EmissiveColor);
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}
}

UEarthWalkAssetsCommandlet::UEarthWalkAssetsCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UEarthWalkAssetsCommandlet::Main(const FString& Params)
{
	IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get();
	// -only=figure, -only=sky, -only=ink or -only=fence builds just that material and leaves the others as they are.
	FString Only;
	if (FParse::Value(*Params, TEXT("only="), Only) && Only.Equals(TEXT("ink"), ESearchCase::IgnoreCase))
	{
		BuildInkMaterial(Tools);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: M_EarthInk only"));
		return 0;
	}
	if (FParse::Value(*Params, TEXT("only="), Only) && Only.Equals(TEXT("figure"), ESearchCase::IgnoreCase))
	{
		BuildFigureMaterial(Tools);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: M_EarthFigure only"));
		return 0;
	}
	if (Only.Equals(TEXT("model"), ESearchCase::IgnoreCase))
	{
		BuildModelMaterial(Tools);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: M_EarthModel only"));
		return 0;
	}
	if (Only.Equals(TEXT("fence"), ESearchCase::IgnoreCase))
	{
		BuildFenceMaterial(Tools);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: M_EarthFence only"));
		return 0;
	}
	if (Only.Equals(TEXT("sky"), ESearchCase::IgnoreCase))
	{
		BuildSkyMaterial(Tools);
		BuildFallMaterial(Tools);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: M_EarthSky and M_EarthFall only"));
		return 0;
	}
	BuildFigureMaterial(Tools);
	BuildModelMaterial(Tools);
	BuildPaintedMaterial(Tools, TEXT("M_EarthTop"), TopCode, false);
	BuildPaintedMaterial(Tools, TEXT("M_EarthWall"), WallCode, true);
	BuildInkMaterial(Tools);
	BuildWaterMaterial(Tools);
	BuildFoliageMaterial(Tools);
	BuildSkyMaterial(Tools);
	BuildFenceMaterial(Tools);
	BuildFallMaterial(Tools);

	UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: 9 materials under /Game/EarthWalk"));
	return 0;
}
