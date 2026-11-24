# 공식 문서 제품 이미지 보조 검토 · 2026-10-27

범위는 지정한 3장이다. [Profile 문서](https://linear.app/docs/profile)의 `Profile picture`와 `Display full names`, [Workspaces 문서](https://linear.app/docs/workspaces)의 `Linear workspace switcher` 이미지 링크를 실제로 열고 원본 PNG를 확보하여 눈으로 확인했다. 인증된 앱의 설정 화면에 접근한 것이 아니다. 캡처 시기·DPR·배율·앱 빌드는 미상이며 현재 지정된 첨부 기준의 보조 자료다. 원본 URL/크기/바이트/SHA-256은 `official-images-manifest.json`에 기록했다.

| 이미지 | 원본 크기 | SHA-256 |
|---|---|---|
| official-profile-picture.png | 1378×176 | 2ab6d811a8b9fe7303cd35c3910d3db6c39506ff657e04bf96970f005ae49a3c |
| official-display-full-names.png | 1332×148 | 7a286d125495c95988be77dbdc767ddffb4d6b62916f2f281f27c033873a86a4 |
| official-workspace-switcher.png | 1264×673 | 65addde7a1bf0b2f3b98920d3008172f5585d76109493e1cdfc3917d4d52ab54 |

## 관찰과 현재 구현 대응

- Profile picture: 테두리가 있는 설정 그룹 안에서 왼쪽 라벨, 오른쪽 원형 아바타, 아래 구분선이다. 전체 페이지나 모달 구조는 잘려 있어 확인할 수 없다. 래스터 주요 표면 #17181a, 바깥 #101011, 경계 계열 #2b2d34/#2e3037.
- Display full names: 같은 설정 그룹의 왼쪽 제목+보조 설명, 오른쪽 스위치, 위아래 경계다. 제목은 밝고 설명은 낮은 강조다. 사진 변경/성명 표시 기능을 Paper에 새로 추가하라는 근거가 아니다.
- 현재 Paper 프로필의 이름/색상 2행 설정 그룹은 좌측 라벨·우측 컨트롤·내부 구분선·평평한 표면 규칙에 부합한다. `remaining-settings/hub-profile-dark-normal.png`와 `workspace-profile-light-normal.png`를 직접 확인했다. 이름 입력/색상 팔레트 및 저장/취소 모달은 Paper의 실제 기능 차이다. 공식 crop만으로 이 모달 전체의1:1 일치를 판정할 수 없다.
- Workspace switcher: 왼쪽 상단 브랜드에서 메뉴가 열리고, 중립 팝업·구분선·선택행·오른쪽 단축키/하위메뉴 표시를 사용한다. Switch workspace의 하위 메뉴에는 계정 설명, 정사각형 워크스페이스 아이콘, 이름, 현재 항목 오른쪽 체크가 있다. 검색 입력은 이 이미지에 없다.
- 현재 Paper는 검색+프로젝트 목록+프로필/화면 설정 footer를 한 팝오버에 모은다. 실제 구현 `bootstrap.js`/`theme.css`를 읽어 검색행, 구분선, 프로젝트 아이콘, 현재 항목 체크, hover/focus 배경을 확인했다. 이 조합은 공통 외형 규칙에 맞지만, Linear의2단 메뉴를 그대로 복제한 구조는 아니다. 프로젝트를 빠르게 찾는 Paper의 탐색 기능에 따른 설명 가능한 차이다. 실제 현재 프로젝트 메뉴의 새 렌더는 이번 한정 작업에서 실행하지 않았다.

## 판단

이3장 때문에 추가로 드러난 **중대한 설명 불가능한 시각 차이는 없다**. 설정 행 정렬과 메뉴의 선택/그룹/현재항목 표현은 보조 근거와 일관된다. 다만 검색/한단 메뉴/프로필 모달의 전체 배치까지 공식 이미지와1:1 검증했다고 주장해서는 안 된다. 시기가 미상인 원본의 확대 픽셀 크기를 현재 CSS px로 환산하여 강제 적용하지 않았다. 이 관찰만으로 완료된 전수 검사를 반복하거나 전역 디자인 토큰을 변경할 근거도 없다.

앱·CSS·JS 수정, 추가 앱 탐색, 폼 전송, 이미지 생성은 수행하지 않았다.
