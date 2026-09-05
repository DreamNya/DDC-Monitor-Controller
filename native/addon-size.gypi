{
    "configurations": {
        "Release": {
            "msvs_settings": {
                "VCCLCompilerTool": {
                    "Optimization": 1,
                    "FavorSizeOrSpeed": 2,
                    "InlineFunctionExpansion": 2,
                    "EnableFunctionLevelLinking": "true",
                    "StringPooling": "true",
                    "WholeProgramOptimization": "true",
                    "RuntimeTypeInfo": "false",
                    "BufferSecurityCheck": "true",
                    "DebugInformationFormat": 0,
                    "AdditionalOptions": ["/Gw"]
                },
                "VCLinkerTool": {
                    "AdditionalOptions!": ["/LTCG:INCREMENTAL"],
                    "AdditionalOptions": ["/MERGE:_RDATA=.rdata"],
                    "LinkTimeCodeGeneration": 1,
                    "OptimizeReferences": 2,
                    "EnableCOMDATFolding": 2,
                    "LinkIncremental": 1,
                    "GenerateDebugInformation": "false",
                    "GenerateMapFile": "true",
                    "MapFileName": "$(OutDir)$(TargetName).map"
                }
            }
        }
    }
}
