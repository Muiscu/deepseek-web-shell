package com.example.selftest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView tv = new TextView(this);
        tv.setText(getString(R.string.hello_text));
        tv.setTextSize(18f);
        setContentView(tv);
    }
}
