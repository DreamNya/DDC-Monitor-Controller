{
    "targets": [
        {
            "target_name": "MonitorNative",
            "sources": ["addon.cpp"],
            "include_dirs": [
                "<!(node -p \"require('node-addon-api').include_dir\")"
            ],
            "defines": [
                "NAPI_CPP_EXCEPTIONS",
                "_HAS_EXCEPTIONS=1",
                "UNICODE",
                "_UNICODE"
            ],
            "conditions": [
                [
                    "OS=='win'",
                    {
                        "msvs_settings": {
                            "VCCLCompilerTool": {
                                "ExceptionHandling": 1,
                                "WarningLevel": 4,
                                "DisableSpecificWarnings": [
                                    "4127"
                                ],
                                "AdditionalOptions": [
                                    "/utf-8",
                                    "/permissive-"
                                ]
                            },
                            "VCLinkerTool": {
                                "AdditionalDependencies": [
                                    "Dxva2.lib",
                                    "User32.lib"
                                ]
                            }
                        }
                    }
                ]
            ]
        }
    ]
}
