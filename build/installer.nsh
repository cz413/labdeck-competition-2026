!macro customUnInstallSection
  Section /o "un.同时清除 LabDeck 参赛版本机配置与数据" SEC_DELETE_COMPETITION_DATA
    SetShellVarContext current
    RMDir /r "$APPDATA\LabDeck-Competition-2026"
  SectionEnd
!macroend
