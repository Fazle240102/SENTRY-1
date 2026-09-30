#include <ESP32Servo.h>

#define TRIG_PIN 4
#define ECHO_PIN 15
#define SERVO_PIN 13
#define BUZZER_PIN 14

#define ALERT_DISTANCE 20
#define MIN_ANGLE 15
#define MAX_ANGLE 165
#define STEP_DELAY 25

// Timeout for pulseIn(), in microseconds.
// distance = (time * 0.034) / 2  =>  time = (distance * 2) / 0.034
// For our 40cm working range that's ~2350us. 6000us gives roughly a
// 2.5x safety margin — enough that borderline 35-40cm readings complete
// reliably, while still far shorter than the original 30000us (sized
// for the sensor's full 400cm spec range), which is what caused the
// sweep to visibly slow down whenever nothing was in range.
#define ECHO_TIMEOUT_US 6000

Servo myServo;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  myServo.attach(SERVO_PIN);

  digitalWrite(BUZZER_PIN, LOW);
}

void loop() {
  for (int angle = MIN_ANGLE; angle <= MAX_ANGLE; angle++) {
    myServo.write(angle);
    delay(STEP_DELAY);
    scanAndAlert(angle);
  }

  for (int angle = MAX_ANGLE; angle > MIN_ANGLE; angle--) {
    myServo.write(angle);
    delay(STEP_DELAY);
    scanAndAlert(angle);
  }
}

void scanAndAlert(int angle) {
  float distance = getFilteredDistance();

  Serial.print("Angle:");
  Serial.print(angle);
  Serial.print(",Distance:");
  Serial.println(distance);

  if (distance > 0 && distance < ALERT_DISTANCE) {
    digitalWrite(BUZZER_PIN, HIGH);
  } else {
    digitalWrite(BUZZER_PIN, LOW);
  }
}

float getFilteredDistance() {
  const int SAMPLES = 5;
  float readings[SAMPLES];
  int validCount = 0;

  for (int i = 0; i < SAMPLES; i++) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);

    long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
    float d = duration * 0.034 / 2;

    if (d >= 2 && d <= 40) {  // capped at our actual working range
      readings[validCount] = d;
      validCount++;
    }
    delay(5);
  }

  if (validCount == 0) return 0;

  for (int i = 0; i < validCount - 1; i++) {
    for (int j = 0; j < validCount - i - 1; j++) {
      if (readings[j] > readings[j + 1]) {
        float temp = readings[j];
        readings[j] = readings[j + 1];
        readings[j + 1] = temp;
      }
    }
  }

  return readings[validCount / 2];
}