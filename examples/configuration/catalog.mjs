export const catalog = {schemaVersion: 1, defaultLocale: 'en', messages: {
  en: {
    'plugin.name': 'Configuration example', 'page.lead': 'Validated settings and commands, with language-aware labels.',
    'settings.title': 'Settings', 'settings.multiplier': 'Multiplier', 'settings.help': 'Workspace values take priority over user values and defaults.', 'settings.token': 'Execution reference', 'settings.format': 'Result format',
    'settings.scope': 'Save to', 'settings.user': 'User', 'settings.workspace': 'Workspace', 'settings.save': 'Save setting', 'settings.reset': 'Reset setting', 'settings.effective': 'Effective value: {value} · Source: {source} · Revision: {revision}',
    'command.title': 'Summarize', 'command.help': 'Count the supplied names using the current multiplier and an authorized reference.',
    'input.names': 'Names', 'input.help': 'Enter 1–8 names, separated by commas.', 'input.mode': 'Summary style', 'input.short': 'Short', 'input.detailed': 'Detailed',
    'execution.hold': 'Hold execution to try switching languages', 'execution.continue': 'Continue execution', 'execution.waiting': 'Execution is held. Change the language, then continue.', 'execution.ready': 'Ready',
    'result.summary': '{count} names × multiplier = {total}. Style: {mode}.', 'error.validation': 'Check field {path}.', 'error.operation': 'Operation failed: {code}.',
    'reference.revoke': 'Revoke reference', 'reference.renew': 'Issue new reference', 'reference.active': 'Reference available', 'reference.revoked': 'Reference revoked',
    'literal.title': 'Literal text check', 'literal.sample': '<img src=x onerror="alert(1)"> is displayed as text.',
    'audit.title': 'Display checks', 'audit.summary': '{conflicts} shortcut conflicts · {contrast} contrast warnings · {missing} untranslated display keys',
    'theme.name': 'Example palette', 'theme.toggle': 'Switch appearance',
  },
  ko: {
    'plugin.name': '설정 예제', 'page.lead': '입력 검증과 다국어 표시를 지원하는 설정·명령 예제입니다.',
    'settings.title': '설정', 'settings.multiplier': '배수', 'settings.help': '워크스페이스 값이 사용자 값과 기본값보다 우선합니다.', 'settings.token': '실행 참조', 'settings.format': '결과 형식',
    'settings.scope': '저장 범위', 'settings.user': '사용자', 'settings.workspace': '워크스페이스', 'settings.save': '설정 저장', 'settings.reset': '설정 재설정', 'settings.effective': '유효값: {value} · 출처: {source} · 리비전: {revision}',
    'command.title': '요약 실행', 'command.help': '현재 배수와 허용된 참조를 사용해 입력한 이름의 수를 계산합니다.',
    'input.names': '이름', 'input.help': '쉼표로 구분한 이름 1~8개를 입력하세요.', 'input.mode': '요약 방식', 'input.short': '간단히', 'input.detailed': '자세히',
    'execution.hold': '언어 전환을 확인하도록 실행 대기', 'execution.continue': '실행 계속', 'execution.waiting': '실행이 대기 중입니다. 언어를 바꾼 후 계속하세요.', 'execution.ready': '준비됨',
    'result.summary': '이름 {count}개 × 배수 = {total}. 방식: {mode}.', 'error.validation': '{path} 필드를 확인하세요.', 'error.operation': '작업 실패: {code}.',
    'reference.revoke': '참조 철회', 'reference.renew': '새 참조 발급', 'reference.active': '참조 사용 가능', 'reference.revoked': '참조 철회됨',
    'literal.title': '일반 텍스트 표시 확인', 'literal.sample': '<img src=x onerror="alert(1)">는 텍스트로 표시됩니다.',
    'audit.title': '표시 점검', 'audit.summary': '단축키 충돌 {conflicts}개 · 대비 경고 {contrast}개 · 미번역 표시 키 {missing}개',
    'theme.name': '예제 색상', 'theme.toggle': '화면 테마 전환',
  },
  ar: {'plugin.name': 'مثال الإعدادات', 'page.lead': 'إعدادات وأوامر مع تسميات متعددة اللغات.', 'settings.title': 'الإعدادات', 'settings.multiplier': 'المضاعف', 'command.title': 'تلخيص', 'input.names': 'الأسماء'},
  'en-XA': {'plugin.name': '[ Configuration example with a deliberately long translated title for layout testing ]', 'settings.multiplier': '[ Multiplier — this deliberately extended label must wrap within the available space ]', 'command.title': '[ Summarize the supplied names with the selected workspace settings ]'},
}, fallbacks: {ar: ['en'], 'en-XA': ['en']}};
export const exampleTheme = {name: 'Configuration example', colors: {
  light: {backdrop: '#f6f7fb', navigation: '#ffffff', tool: '#ffffff', main: '#ffffff', text: '#17203a', muted: '#4b556b'},
  dark: {backdrop: '#101625', navigation: '#192236', tool: '#192236', main: '#192236', text: '#f0f3ff', muted: '#b8c4de'},
}};
