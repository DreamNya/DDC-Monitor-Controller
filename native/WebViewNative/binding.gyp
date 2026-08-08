{
    "targets": [
        {
            "target_name": "WebViewNative",
            "sources": ["addon.cpp", "native_shell.cpp"],
            "include_dirs": [
                "<!(node -p \"require('node-addon-api').include_dir\")",
                "<!(node -e \"process.stdout.write(require('path').join(process.env.WEBVIEW2_SDK_DIR, 'build', 'native', 'include'))\")"
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
                                "DisableSpecificWarnings": ["4127"],
                                "AdditionalOptions": ["/utf-8", "/permissive-", "/std:c++20"]
                            }
                        },
                        "libraries": [
                            "<!(node -e \"process.stdout.write(require('path').join(process.env.WEBVIEW2_SDK_DIR, 'build', 'native', 'x64', 'WebView2LoaderStatic.lib'))\")",
                            "Dwmapi.lib",
                            "Ole32.lib",
                            "Shell32.lib",
                            "Shcore.lib",
                            "Shlwapi.lib",
                            "User32.lib",
                            "Version.lib"
                        ]
                    }
                ]
            ]
        }
    ]
}
