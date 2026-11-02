; Dark Mechanicus additions to electron-builder's NSIS installer and uninstaller.

; electron-builder's check for a running app counts the processes that run from the install folder with PowerShell's
; .Count, which reads nothing when there is exactly one (a lone CimInstance has no Count). It then installs over that
; process's open DarkMechanicus.exe and app.asar, which Windows refuses, and leaves the old exe beside the new Electron
; files: an app that crashes on start. An agent session's Dark Mechanicus MCP server is often that one process.
; This is electron-builder's check with the processes counted as an array; closing and then killing them is unchanged.
!include "getProcessInfo.nsh"
Var pid

!macro FIND_INSTALLED_PROCESS _FILE _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    !insertmacro FIND_PROCESS "${_FILE}" ${_RETURN}
  ${endIf}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      # allow app to exit without explicit kill
      Sleep 300
    ${endIf}

    !insertmacro FIND_INSTALLED_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        # allow app to exit without explicit kill
        Sleep 1000
        Goto doStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:

      DetailPrint "$(appClosing)"

      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      # to ensure that files are not "in-use"
      Sleep 300

      # Retry counter
      StrCpy $R1 0

      loop:
        IntOp $R1 $R1 + 1

        !insertmacro FIND_INSTALLED_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          # wait to give a chance to exit gracefully
          Sleep 1000
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1 # 1 = force kill
          !insertmacro FIND_INSTALLED_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto not_running
          ${endIf}
        ${else}
          Goto not_running
        ${endIf}

        # App likely running with elevated permissions.
        # Ask user to close it manually
        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          Quit
        ${else}
          Goto loop
        ${endIf}
      not_running:
    ${endIf}
  ${endIf}
!macroend
