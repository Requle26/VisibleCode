# Memory Studio

Java, C#, Python, Rust 코드를 실행하고 호출 프레임, 객체와 값, 참조 관계를 마인드맵처럼 따라가는 한국어 학습 웹입니다.

## 로컬 실행

프론트엔드는 `frontend/`, 실행 API는 `backend/`에 있습니다. 로컬 개발에는 Node.js 22.19 이상과 사용할 언어의 실행 환경이 필요합니다.

| 버전 | 경로 | 실행 환경 |
| --- | --- | --- |
| Java | `/` | JDK 17 이상 (`java`, `javac`) |
| C# | `/csharp` | .NET SDK 8 이상 (`dotnet`) |
| Python | `/python` | Python 3.9 이상 (`python3`) |
| Rust | `/rust` | `rustc` 및 Python 스크립팅을 지원하는 `lldb` |

```sh
npm ci --prefix backend
npm ci --prefix frontend
npm start
```

[localhost:5180](http://localhost:5180)을 열면 두 이름이 같은 `Student` 객체를 가리키는 예제가 표시됩니다. **다음 단계**를 누르면 한쪽에서 값을 수정했을 때 다른 쪽에서도 `95`를 읽는 과정을 볼 수 있습니다. 입력창 왼쪽 아래에서 언어를 바꿀 수 있으며, 편집 내용은 브라우저에 언어별로 저장됩니다. 코드 수정 후 약 0.6초 뒤 자동으로 다시 실행합니다.

`PORT=5181 npm start`처럼 포트를 바꿀 수 있습니다. 서버를 나눠서 실행하려면 `npm --prefix backend run dev`(8787)와 `npm --prefix frontend run dev`(5173)를 별도 터미널에서 실행하세요. Rust 실행 파일은 `RUSTC_BIN`, `LLDB_BIN`으로 지정할 수 있으며, macOS에서는 Xcode Command Line Tools의 LLDB를 사용할 수 있습니다.

- **스택:** 호출된 메서드의 프레임, 매개변수, 지역 변수
- **힙:** 객체와 배열, 인스턴스 필드, 참조 화살표
- **클래스 영역:** 사용자 클래스의 메서드 정의와 클래스 수준 필드
- **타임라인:** 첫 단계 / 이전 / 다음 / 마지막, 자동 재생, 실행 줄 표시
- **캔버스:** 노드 드래그, 배경 이동, 확대·축소, 기본 배치. 변수나 객체를 누르면 관련된 참조가 강조됩니다.

## 구현 및 범위

React·TypeScript와 CodeMirror를 사용합니다. Java는 JDI로 실제 JVM 상태를 읽고, C#은 Roslyn으로 실행 상태를 기록하는 코드를 삽입한 뒤 .NET에서 실행하며, Python은 `sys.settrace`로 줄 단위 상태를 읽습니다. Python에서는 정수와 문자열도 객체로 표현하며, 모듈 수준 이름은 전역 딕셔너리 카드의 항목으로 표시합니다.

단일 파일의 학습 예제를 대상으로 하며 Java `main`, C# `Main` 또는 최상위 문장, Python 스크립트를 실행할 수 있습니다. 사용자 코드의 호출과 값 변화를 최대 350단계까지 기록하며, 여러 스레드·대화형 표준 입력·외부 패키지 관리는 지원 범위에 포함되지 않습니다. C#에서 일부 문법은 실행 결과만 표시될 수 있습니다. `@번호`는 학습용 객체 식별자이며, 회색 객체는 현재 표시된 참조에서 도달할 수 없다는 뜻입니다.

Rust는 표준 라이브러리만 사용하는 단일 파일(Rust 2021 에디션)을 컴파일하고, LLDB 디버그 정보에서 읽을 수 있는 함수와 변수를 최대 140단계까지 표시합니다. 메모리 위치를 확정할 수 없는 값은 **참조 대상**으로 표시합니다. `String`, `Vec`, 슬라이스는 디버거가 읽을 수 있는 레이아웃에서 앞부분만 보여 주고, 확인할 수 없는 열거형은 미리보기를 생략합니다. 타임라인에는 소유권 이동 전 값이 남아 보일 수 있으므로, 빌림과 소유권의 유효 여부는 컴파일러 진단을 기준으로 판단하세요. 복합 예제는 [`rust-ledger.rs`](frontend/tests/fixtures/rust-ledger.rs)와 [`rust-steps.rs`](frontend/tests/fixtures/rust-steps.rs)에 있습니다.

로컬 개발 백엔드는 루프백에서만 수신하며 입력한 코드를 현재 사용자 권한으로 실행합니다. 로컬 개발에서는 직접 작성했거나 신뢰하는 코드만 실행하세요.

## 배포: Render + Vercel

브라우저 → Vercel의 `/api/trace` → Render의 `/api/trace` → 요청별 E2B 샌드박스 순으로 실행합니다. Render 웹 서비스 프로세스에는 제출한 코드를 실행하지 않습니다. E2B 계정과 커스텀 샌드박스 템플릿이 필요합니다.

1. **샌드박스 템플릿:** `backend/.env.example`을 참고해 `backend/.env`에 `E2B_API_KEY`와 원하는 `E2B_TEMPLATE` 이름을 설정합니다. 저장소 루트에서 `npm --prefix backend run sandbox:build`를 실행합니다. 템플릿에 Java 17, .NET 8, Python, Rust 1.96, LLDB 19와 추적기가 설치됩니다. 기존 배포에 Rust를 추가할 때는 템플릿을 먼저 다시 빌드한 후 Render와 Vercel을 배포하세요.
2. **Render:** `render.yaml`로 Blueprint를 배포하거나 Node Web Service를 만들고 Root Directory를 `backend`, Build Command를 `npm ci`, Start Command를 `npm start`, Health Check Path를 `/api/health`로 설정합니다. 환경 변수 `E2B_API_KEY`, `E2B_TEMPLATE`, `TRACE_API_TOKEN`을 넣습니다. 토큰은 `openssl rand -hex 32`로 생성할 수 있습니다.
3. **Vercel:** Root Directory를 `frontend`로 설정합니다. `TRACE_BACKEND_URL`에 Render의 HTTPS 주소(예: `https://visiblecode-api.onrender.com`)를, `TRACE_API_TOKEN`에 Render와 같은 토큰을 넣고 배포합니다. 두 변수 모두 Vercel 서버에서만 읽으므로 `VITE_` 접두사를 붙이지 않습니다.

실행 샌드박스는 요청별로 생성하고 외부 네트워크를 차단하며 종료 후 삭제합니다. Render 인스턴스당 동시 실행과 분당 요청을 제한합니다. 공개 사이트라면 Vercel에서도 `/api/trace`의 요청량 제한을 설정하고 E2B 사용량을 확인하세요. Render 무료 인스턴스가 절전 상태라면 첫 요청은 시간 초과될 수 있습니다.

배포 API는 실행당 최대 16MiB의 추적 결과를 Vercel에서 스트리밍합니다. 기존 배포에 이 변경을 적용할 때는 E2B 템플릿을 먼저 다시 빌드하고, Vercel 프록시와 Render API를 새 커밋으로 배포하세요. 새 템플릿은 이전 Render API의 4MiB 요청도 지원합니다.

## 검증

```sh
npm test
npm run build
```
