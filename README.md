# Tonearm

손(엄지+검지 핀치)으로 LP 톤암을 집어 판 위에 올리면 유튜브 음악이 재생되는 웹사이트.

- **데모 바로가기**: https://re2031.github.io/lp-tonearm/
- 재생: YouTube IFrame API
- 손 인식: MediaPipe Hand Landmarker
- 카메라가 없으면 마우스로 드래그해서 테스트 가능

## 로컬 실행
```
python -m http.server 8080
```
브라우저에서 http://localhost:8080 (카메라는 localhost 또는 https 에서만 동작)
