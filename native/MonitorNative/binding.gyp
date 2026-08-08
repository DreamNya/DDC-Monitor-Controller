{
    "targets": [
        {
            "target_name": "MonitorNative",
            "sources": ["addon.cpp"],
            "dependencies": [
                "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
            ],
            "defines": [
                "UNICODE",
                "_UNICODE"
            ],
            "conditions": [
                [
                    "OS=='win'",
                    {
                        "msvs_settings": {
                            "VCCLCompilerTool": {
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
