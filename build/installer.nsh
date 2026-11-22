; Dark Mechanicus additions to electron-builder's NSIS installer and uninstaller.

; Find every executable beneath the install directory without starting PowerShell/.NET or WMI.
; QueryFullProcessImageNameW supports 64-bit targets from this 32-bit NSIS installer.
!include "getProcessInfo.nsh"
!include "x64.nsh"
Var pid

!macro DM_NATIVE_DETECT_BODY
 ; Stack: install directory -> 0 found, 1 absent, 2 inconclusive. Preserve caller registers.
 Exch $0
 Push $1
 Push $2
 Push $3
 Push $4
 Push $5
 Push $6
 Push $7
 Push $8
 Push $9
 Push $R0
 Push $R1
 StrCpy $9 2
 StrCpy $2 0
 StrCpy $R0 0
 StrCpy $4 $0 1 -1
 StrCmp $4 "\" +2
 StrCpy $0 "$0\"
 StrLen $5 $0
 System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.r1'
 StrCmp $1 -1 dm_done
 ; PROCESSENTRY32W is 556 bytes in the 32-bit NSIS process; PID is at offset 8.
 System::Alloc 556
 Pop $2
 StrCmp $2 0 dm_cleanup
 ; Windows permits 32767-character executable paths. Read only the prefix into an NSIS string.
 System::Alloc 65536
 Pop $R0
 StrCmp $R0 0 dm_cleanup
 System::Call '*$2(i 556)'
 System::Call 'kernel32::Process32FirstW(p r1, p r2) i.r8 ?e'
 Pop $R1
 dm_loop:
 StrCmp $8 0 dm_end
 System::Call '*$2(i, i, i.r6)'
 System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r6) p.r3'
 ; Unreadable/protected/exited processes have no usable path, as with the previous detector.
 StrCmp $3 0 dm_next
 System::Call 'kernel32::QueryFullProcessImageNameW(p r3, i 0, p R0, *i 32768) i.r8'
 System::Call 'kernel32::CloseHandle(p r3)'
 StrCmp $8 0 dm_next
 System::Call '*$R0(&w${NSIS_MAX_STRLEN}.r4)'
 StrCpy $4 $4 $5
 StrCmp $4 $0 dm_found
 dm_next:
 System::Call 'kernel32::Process32NextW(p r1, p r2) i.r8 ?e'
 Pop $R1
 Goto dm_loop
 dm_end:
 ; Only ERROR_NO_MORE_FILES establishes absence; other enumeration errors use the fallback.
 StrCmp $R1 18 0 dm_cleanup
 StrCpy $9 1
 Goto dm_cleanup
 dm_found:
 StrCpy $9 0
 dm_cleanup:
 System::Free $R0
 System::Free $2
 System::Call 'kernel32::CloseHandle(p r1)'
 dm_done:
 StrCpy $0 $9
 Pop $R1
 Pop $R0
 Pop $9
 Pop $8
 Pop $7
 Pop $6
 Pop $5
 Pop $4
 Pop $3
 Pop $2
 Pop $1
 Exch $0
!macroend

!ifdef BUILD_UNINSTALLER
Function un.DmNativeDetect
!else
Function DmNativeDetect
!endif
 !insertmacro DM_NATIVE_DETECT_BODY
FunctionEnd

!macro FIND_INSTALLED_PROCESS _FILE _RETURN
  Push $INSTDIR
  !ifdef BUILD_UNINSTALLER
    Call un.DmNativeDetect
  !else
    Call DmNativeDetect
  !endif
  Pop ${_RETURN}
  ${if} ${_RETURN} == 2
    ; A failed snapshot is inconclusive. Keep electron-builder's native filename fallback.
    Push $IsPowerShellAvailable
    StrCpy $IsPowerShellAvailable 1
    !insertmacro FIND_PROCESS "${_FILE}" ${_RETURN}
    Pop $IsPowerShellAvailable
    ${if} ${_RETURN} != 0
    ${andIf} ${_RETURN} != 1
      MessageBox MB_OK|MB_ICONSTOP "Unable to inspect running applications. Close Dark Mechanicus and try again. If the problem continues, restart Windows before installing." /SD IDOK
      SetErrorLevel 2
      Quit
    ${endIf}
  ${endIf}
!macroend

!macro customCheckAppRunning
  ; Declare electron-builder's availability variable before use, but launch PowerShell only
  ; after native detection and the person's confirmation, when inherited termination needs it.
  Goto dm_detect_installed
  dm_prepare_termination:
    ${if} ${RunningX64}
      StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    ${endIf}
    !insertmacro IS_POWERSHELL_AVAILABLE
    Goto doStopProcess
  dm_detect_installed:
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
        Goto dm_prepare_termination
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK dm_prepare_termination
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
