#include "EarthModels.h"

#include "Engine/StaticMesh.h"
#include "MeshDescription.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "StaticMeshAttributes.h"

namespace
{
	struct FModel
	{
		const TCHAR* Rig;
		const int16* P;
		const int8* N;
		const uint8* C;
		int32 NumCorners;
		const uint16* I;
		int32 NumIndices;
	};

#include "EarthModels.gen.inl"
}

bool EarthModels::On()
{
	static const bool bOn = []
	{
		FString Which;
		return FParse::Value(FCommandLine::Get(), TEXT("-EWModels="), Which) && Which.Equals(TEXT("free"), ESearchCase::IgnoreCase);
	}();
	return bOn;
}

int32 EarthModels::Num()
{
	return UE_ARRAY_COUNT(Models);
}

const TCHAR* EarthModels::RigOf(int32 Index)
{
	return Models[Index].Rig;
}

UStaticMesh* EarthModels::Build(UObject* Outer, int32 Index)
{
	const FModel& Model = Models[Index];
	FMeshDescription Description;
	FStaticMeshAttributes Attributes(Description);
	Attributes.Register();
	TVertexAttributesRef<FVector3f> Positions = Attributes.GetVertexPositions();
	TVertexInstanceAttributesRef<FVector3f> Normals = Attributes.GetVertexInstanceNormals();
	TVertexInstanceAttributesRef<FVector3f> Tangents = Attributes.GetVertexInstanceTangents();
	TVertexInstanceAttributesRef<float> Signs = Attributes.GetVertexInstanceBinormalSigns();
	TVertexInstanceAttributesRef<FVector4f> Colours = Attributes.GetVertexInstanceColors();
	TVertexInstanceAttributesRef<FVector2f> UVs = Attributes.GetVertexInstanceUVs();
	UVs.SetNumChannels(1);

	const FPolygonGroupID Group = Description.CreatePolygonGroup();
	Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Paint");
	Description.ReserveNewVertices(Model.NumCorners);
	Description.ReserveNewVertexInstances(Model.NumCorners);
	Description.ReserveNewTriangles(Model.NumIndices / 3);

	TArray<FVertexInstanceID> Corners;
	Corners.Reserve(Model.NumCorners);
	for (int32 i = 0; i < Model.NumCorners; ++i)
	{
		const FVertexID Vertex = Description.CreateVertex();
		Positions[Vertex] = FVector3f(Model.P[i * 3], Model.P[i * 3 + 1], Model.P[i * 3 + 2]) * 0.1f;
		const FVertexInstanceID Corner = Description.CreateVertexInstance(Vertex);
		const FVector3f Normal = FVector3f(Model.N[i * 3], Model.N[i * 3 + 1], Model.N[i * 3 + 2]).GetSafeNormal(UE_SMALL_NUMBER, FVector3f::UpVector);
		Normals[Corner] = Normal;
		// Nothing here uses a tangent, but give each corner a true one all the same.
		const FVector3f Across = FMath::Abs(Normal.Z) < 0.9f ? FVector3f::UpVector : FVector3f::ForwardVector;
		Tangents[Corner] = FVector3f::CrossProduct(Across, Normal).GetSafeNormal();
		Signs[Corner] = 1.f;
		// The engine keeps a corner's colour as it would a picture's (sRGB), so hand it over as light.
		const FLinearColor Paint = FLinearColor::FromSRGBColor(FColor(Model.C[i * 4], Model.C[i * 4 + 1], Model.C[i * 4 + 2]));
		Colours[Corner] = FVector4f(Paint.R, Paint.G, Paint.B, Model.C[i * 4 + 3] / 255.f);
		UVs.Set(Corner, 0, FVector2f::ZeroVector);
		Corners.Add(Corner);
	}
	for (int32 i = 0; i + 2 < Model.NumIndices; i += 3)
	{
		Description.CreateTriangle(Group, { Corners[Model.I[i]], Corners[Model.I[i + 1]], Corners[Model.I[i + 2]] });
	}

	UStaticMesh* Mesh = NewObject<UStaticMesh>(Outer, NAME_None, RF_Transient);
	Mesh->GetStaticMaterials().Add(FStaticMaterial(nullptr, TEXT("Paint")));
	UStaticMesh::FBuildMeshDescriptionsParams Params;
	Params.bFastBuild = true;
	Params.bBuildSimpleCollision = false;
	Params.bCommitMeshDescription = false;
	Params.bMarkPackageDirty = false;
	Mesh->BuildFromMeshDescriptions({ &Description }, Params);
	return Mesh;
}
