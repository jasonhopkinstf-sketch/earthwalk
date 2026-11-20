# Downloads the CC0 textures the world materials use (from Poly Haven, 1k JPG, colour + normal)
# into game\Textures, which is not committed. game\Tools\build-assets.cmd then imports them.
# Poly Haven textures are CC0: free for any use, no attribution required (https://polyhaven.com/license).
$ErrorActionPreference = "Stop"
$dest = Join-Path (Split-Path $PSScriptRoot -Parent) "Textures"
New-Item -ItemType Directory -Force $dest | Out-Null

# name = how the game refers to it; id = Poly Haven asset id.
$textures = @(
  @{ name = "plaster"; id = "beige_wall_001" },
  @{ name = "brick"; id = "red_brick_03" },
  @{ name = "concrete"; id = "concrete_wall_008" },
  @{ name = "asphalt"; id = "asphalt_02" },
  @{ name = "grass"; id = "grass_ground" },
  @{ name = "forest"; id = "forest_floor" },
  @{ name = "sand"; id = "coast_sand_01" },
  @{ name = "roof_clay"; id = "clay_roof_tiles" },
  @{ name = "roof_grey"; id = "grey_roof_tiles" },
  @{ name = "rock"; id = "cliff_side" },
  @{ name = "gravel"; id = "gravel_floor" },
  @{ name = "soil"; id = "farm_soil" },
  @{ name = "dirt"; id = "dirt_floor" },
  @{ name = "paving"; id = "rectangular_paving" }
)

foreach ($t in $textures) {
  foreach ($kind in @(@{ suffix = "diff"; out = "D" }, @{ suffix = "nor_dx"; out = "N" })) {
    $file = Join-Path $dest "$($t.name)_$($kind.out).jpg"
    if (Test-Path $file) { Write-Host "have    $file"; continue }
    $url = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/$($t.id)/$($t.id)_$($kind.suffix)_1k.jpg"
    Write-Host "getting $url"
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  }
}
Write-Host "Textures are in $dest"
